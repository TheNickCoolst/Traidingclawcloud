import fs from "fs";
import path from "path";
import { config } from "../config.js";

export type LiquidityRole = "maker" | "taker";

export interface FeeTier {
    minVolumeUsd: number;
    maxVolumeUsd: number;
    makerRate: number;
    takerRate: number;
    label: string;
}

const FEE_TIERS: FeeTier[] = [
    { minVolumeUsd: 0, maxVolumeUsd: 100_000, makerRate: 0.0015, takerRate: 0.0025, label: "$0-$100k" },
    { minVolumeUsd: 100_000, maxVolumeUsd: 500_000, makerRate: 0.0012, takerRate: 0.0022, label: "$100k-$500k" },
    { minVolumeUsd: 500_000, maxVolumeUsd: 1_000_000, makerRate: 0.0010, takerRate: 0.0020, label: "$500k-$1m" },
    { minVolumeUsd: 1_000_000, maxVolumeUsd: Number.POSITIVE_INFINITY, makerRate: 0.0008, takerRate: 0.0018, label: "$1m+" },
];

const FEE_REFERENCE_NOTIONAL_USD = 1_000;

function toSafeNonNegativeNumber(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, value);
}

export function getTradingFeeTier(volumeUsd: number = config.tradingFee30dVolumeUsd): FeeTier {
    const safeVolume = toSafeNonNegativeNumber(volumeUsd);
    return FEE_TIERS.find((tier) => safeVolume >= tier.minVolumeUsd && safeVolume < tier.maxVolumeUsd) ?? FEE_TIERS[0];
}

export function getTradingFeeRate(role: LiquidityRole, volumeUsd: number = config.tradingFee30dVolumeUsd): number {
    const tier = getTradingFeeTier(volumeUsd);
    return role === "maker" ? tier.makerRate : tier.takerRate;
}

export function estimateTradingFeeUsd(
    notionalUsd: number,
    role: LiquidityRole = "taker",
    volumeUsd: number = config.tradingFee30dVolumeUsd
): number {
    const safeNotional = toSafeNonNegativeNumber(notionalUsd);
    const rate = getTradingFeeRate(role, volumeUsd);
    return safeNotional * rate;
}

export function estimateRoundTripFeeUsd(
    entryNotionalUsd: number,
    exitNotionalUsd: number = entryNotionalUsd,
    entryRole: LiquidityRole = "maker",
    exitRole: LiquidityRole = "taker",
    volumeUsd: number = config.tradingFee30dVolumeUsd
): number {
    return (
        estimateTradingFeeUsd(entryNotionalUsd, entryRole, volumeUsd)
        + estimateTradingFeeUsd(exitNotionalUsd, exitRole, volumeUsd)
    );
}

export function formatCurrentFeeTierSummary(volumeUsd: number = config.tradingFee30dVolumeUsd): string {
    const tier = getTradingFeeTier(volumeUsd);
    return `30d volume $${toSafeNonNegativeNumber(volumeUsd).toFixed(2)} | tier ${tier.label} | maker ${(tier.makerRate * 100).toFixed(2)}% | taker ${(tier.takerRate * 100).toFixed(2)}%`;
}

export const TRADE_FEE_PER_ORDER = estimateTradingFeeUsd(FEE_REFERENCE_NOTIONAL_USD, "taker");
export const ROUND_TRIP_TRADE_FEE = estimateRoundTripFeeUsd(FEE_REFERENCE_NOTIONAL_USD, FEE_REFERENCE_NOTIONAL_USD, "maker", "taker");

const DAILY_RISK_STATE_PATH = path.join(process.cwd(), "data", "daily-risk-state.json");

interface DailyRiskState {
    date: string;
    startEquity: number;
    breachLocked: boolean;
}

export interface DailyDrawdownStatus {
    date: string;
    startEquity: number;
    currentEquity: number;
    drawdownAmount: number;
    drawdownPercent: number;
    limitAmount: number;
    breached: boolean;
    newlyBreached: boolean;
}

function getDateKeyInTimezone(timezone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());

    const year = parts.find((p) => p.type === "year")?.value ?? "1970";
    const month = parts.find((p) => p.type === "month")?.value ?? "01";
    const day = parts.find((p) => p.type === "day")?.value ?? "01";
    return `${year}-${month}-${day}`;
}

function readDailyRiskState(): DailyRiskState | null {
    try {
        if (!fs.existsSync(DAILY_RISK_STATE_PATH)) return null;
        const raw = fs.readFileSync(DAILY_RISK_STATE_PATH, "utf-8").trim();
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<DailyRiskState>;
        if (!parsed || typeof parsed !== "object") return null;
        if (typeof parsed.date !== "string") return null;
        if (!Number.isFinite(parsed.startEquity)) return null;
        return {
            date: parsed.date,
            startEquity: Number(parsed.startEquity),
            breachLocked: Boolean(parsed.breachLocked),
        };
    } catch {
        return null;
    }
}

function writeDailyRiskState(state: DailyRiskState): void {
    const dir = path.dirname(DAILY_RISK_STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DAILY_RISK_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export function evaluateDailyDrawdown(currentEquity: number): DailyDrawdownStatus {
    const tz = config.heartbeatTimezone || "Europe/Berlin";
    const dateKey = getDateKeyInTimezone(tz);
    const configuredLimitAmount = Math.max(0, config.dailyLossLimitAmount);
    const safeEquity = Number.isFinite(currentEquity) && currentEquity > 0 ? currentEquity : 0;

    let state = readDailyRiskState();
    if (!state || state.date !== dateKey || !Number.isFinite(state.startEquity) || state.startEquity <= 0) {
        state = {
            date: dateKey,
            startEquity: safeEquity,
            breachLocked: false,
        };
        writeDailyRiskState(state);
    }

    const drawdownAmount = safeEquity - state.startEquity;
    const drawdownPercent = state.startEquity > 0 ? drawdownAmount / state.startEquity : 0;
    const minPercent = Math.max(0, config.dailyLossLimitMinPercent);
    const percentLimitAmount = state.startEquity * minPercent;
    const limitAmount = Math.max(configuredLimitAmount, percentLimitAmount);
    const breachedNow = limitAmount > 0 && drawdownAmount <= -limitAmount;

    const newlyBreached = breachedNow && !state.breachLocked;
    if (state.breachLocked !== breachedNow) {
        state.breachLocked = breachedNow;
        writeDailyRiskState(state);
    }

    return {
        date: dateKey,
        startEquity: state.startEquity,
        currentEquity: safeEquity,
        drawdownAmount,
        drawdownPercent,
        limitAmount,
        breached: breachedNow,
        newlyBreached,
    };
}

export function isDailyLossLimitBreached(): boolean {
    const configuredLimitAmount = Math.max(0, config.dailyLossLimitAmount);
    const minPercent = Math.max(0, config.dailyLossLimitMinPercent);
    if (configuredLimitAmount <= 0 && minPercent <= 0) return false;

    const tz = config.heartbeatTimezone || "Europe/Berlin";
    const dateKey = getDateKeyInTimezone(tz);
    const state = readDailyRiskState();
    if (!state || state.date !== dateKey) return false;
    return state.breachLocked;
}
