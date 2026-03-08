/**
 * Trading Engine â€” Autonomous trading loop.
 * Runs on a configurable main cycle (default: every 1 hour).
 * Also runs daily self-reflection (default: every 24 hours).
 */
import { config } from "../config.js";
import { chat } from "../llm.js";
import { getToolDefinitions } from "../tools/index.js";
import { AgentLoop } from "../agent/loop.js";
import * as alpaca from "./alpaca.js";
import { logCycle, logReflection, getRecentTrades, getRecentCycles, getLatestReflection, logTrade, getPerformanceSummary } from "./journal.js";
import { getSector, countBySector, isSectorLimitReached } from "./sectors.js";
import { scoreStock, validateBuySetup, checkExitCondition } from "./strategy.js";
import { runWatchlistScreen } from "./screener.js";
import { estimateTradingFeeUsd, evaluateDailyDrawdown, formatCurrentFeeTierSummary, getTradingFeeRate } from "./risk-controls.js";
import { runSelfImproveCycle } from "./self-improve.js";
import { notifyCycleResult, notifyCycleStart, notifyFastCycleResult } from "./telegram-reporter.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { setTradingExecutionContext } from "./tools.js";
import fs from "fs";
import path from "path";
import cron from "node-cron";

let tradingInterval: any = null;
let reflectionInterval: NodeJS.Timeout | null = null;
let weekendReviewInterval: NodeJS.Timeout | null = null;
let lightInterval: NodeJS.Timeout | null = null;
let ultraLightInterval: NodeJS.Timeout | null = null;
let tradingCycleRunning = false;
let lightCycleRunning = false;
let ultraLightCycleRunning = false;
let reflectionCycleRunning = false;
let lightCycleAbortRequested = false;
const ENGINE_LOCK_PATH = path.join(process.cwd(), "data", `trading-engine-${config.runtimeRole}.lock`);
const MAX_OPEN_POSITIONS = 7;
const LIGHT_CYCLE_YIELD_TIMEOUT_MS = 12_000;
const FAST_CYCLE_IDLE_CACHE_MS = 5 * 60 * 1000;
const US_MARKET_TIMEZONE = "America/New_York";
const US_MARKET_OPEN_MINUTES = (9 * 60) + 30;   // 09:30 ET
const US_MARKET_CLOSE_MINUTES = 16 * 60;        // 16:00 ET (exclusive)
let tradingCycleSequence = 0;
let engineSignalHooksRegistered = false;
let fastCycleIdleUntilMs = 0;
let currentTradingCycleId: number | null = null;
let lastTradingCycleStartedAt: string | null = null;
let lastTradingCycleFinishedAt: string | null = null;
let lastLightCycleAt: string | null = null;
let lastUltraLightCycleAt: string | null = null;
let lastReflectionCycleAt: string | null = null;
let lastLightDecisionAudit: LightDecisionAudit | null = null;
let lastUltraLightDecisionAudit: LightDecisionAudit | null = null;
let lastLightDecisionSummary: string | null = null;
let lastUltraLightDecisionSummary: string | null = null;
let lastTradingSummary: string | null = null;
let lastReflectionSummary: string | null = null;
let lastEngineError: string | null = null;
let lastActivityAt: string | null = null;

type LightDecision = "MAIN" | "LIGHT" | "SKIP";
type FastCycleMode = "light" | "ultra_light";
export type TradingRuntimeMode = "idle" | "trading" | "light" | "ultra_light" | "reflection";

interface LightDecisionResponse {
    decision: LightDecision;
    reason: string;
    confidence: number;
    handover_context: string;
}

interface TradingCycleHandover {
    source: FastCycleMode;
    reason: string;
    context: string;
    confidence: number;
    decidedAt: string;
}

interface LightCycleResult {
    summary: string;
    triggerMain: boolean;
    handover?: TradingCycleHandover;
}

export interface LightDecisionAudit {
    decision: LightDecision;
    reason: string;
    confidence: number;
    handover_context: string;
    forced_main: boolean;
    fallback_reason?: string;
    action_outcome: string;
    estimated_input_tokens: number;
    max_output_tokens: number;
    model: string;
    timestamp: string;
}

export interface TradingRuntimeSnapshot {
    mode: TradingRuntimeMode;
    tradingCycleRunning: boolean;
    lightCycleRunning: boolean;
    ultraLightCycleRunning: boolean;
    lightCycleAbortRequested: boolean;
    currentCycleId: number | null;
    lastTradingCycleStartedAt: string | null;
    lastTradingCycleFinishedAt: string | null;
    lastLightCycleAt: string | null;
    lastUltraLightCycleAt: string | null;
    lastReflectionCycleAt: string | null;
    lastLightDecision: LightDecisionAudit | null;
    lastUltraLightDecision: LightDecisionAudit | null;
    lastLightDecisionSummary: string | null;
    lastUltraLightDecisionSummary: string | null;
    lastTradingSummary: string | null;
    lastReflectionSummary: string | null;
    lastError: string | null;
    lastActivityAt: string | null;
    schedule: {
        timezone: string;
        tradingCycleHours: number;
        reflectionCycleHours: number;
        lightCycleEnabled: boolean;
        lightCycleIntervalMinutes: number;
        ultraLightCycleEnabled: boolean;
        ultraLightCycleIntervalMinutes: number;
        mainCycleCron: string;
        reflectionCron: string;
        weekendReviewCron: string;
        lightCycleCron: string | null;
        ultraLightCycleCron: string | null;
    };
}

function toPositiveInt(value: number, fallback: number): number {
    const n = Math.floor(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFastCycleYield(timeoutMs: number): Promise<boolean> {
    if (!lightCycleRunning && !ultraLightCycleRunning) return true;
    const start = Date.now();
    while ((lightCycleRunning || ultraLightCycleRunning) && (Date.now() - start) < timeoutMs) {
        await sleep(250);
    }
    return !lightCycleRunning && !ultraLightCycleRunning;
}

function getLightCycleCron(): string {
    const interval = Math.min(toPositiveInt(config.lightCycleIntervalMinutes, 1), 59);
    if (interval <= 1) return "* 9-15 * * 1-5";
    return `*/${interval} 9-15 * * 1-5`;
}

function getUltraLightCycleCron(): string {
    const interval = Math.min(toPositiveInt(config.ultraLightCycleIntervalMinutes, 1), 59);
    if (interval <= 1) return "* 9-15 * * 1-5";
    return `*/${interval} 9-15 * * 1-5`;
}

function getMainCycleCron(): string {
    const hourInterval = Math.min(toPositiveInt(config.tradingCycleHours, 1), 12);
    return `30 9-15/${hourInterval} * * 1-5`;
}

function getRuntimeMode(): TradingRuntimeMode {
    if (reflectionCycleRunning) return "reflection";
    if (tradingCycleRunning) return "trading";
    if (ultraLightCycleRunning) return "ultra_light";
    if (lightCycleRunning) return "light";
    return "idle";
}

function touchRuntimeActivity(at: string = new Date().toISOString()): void {
    lastActivityAt = at;
}

function getEngineTimezone(): string {
    return US_MARKET_TIMEZONE;
}

function roleRunsMainCycles(): boolean {
    return config.runtimeRole === "all" || config.runtimeRole === "main";
}

function roleRunsLightCycles(): boolean {
    return config.lightCycleEnabled && (config.runtimeRole === "all" || config.runtimeRole === "light");
}

function roleRunsUltraLightCycles(): boolean {
    return config.ultraLightCycleEnabled && (config.runtimeRole === "all" || config.runtimeRole === "ultra");
}

function getWeekendReviewCron(): string {
    return "5 12 * * 6,0";
}

export function getTradingRuntimeSnapshot(): TradingRuntimeSnapshot {
    const tz = getEngineTimezone();
    return {
        mode: getRuntimeMode(),
        tradingCycleRunning,
        lightCycleRunning,
        ultraLightCycleRunning,
        lightCycleAbortRequested,
        currentCycleId: currentTradingCycleId,
        lastTradingCycleStartedAt,
        lastTradingCycleFinishedAt,
        lastLightCycleAt,
        lastUltraLightCycleAt,
        lastReflectionCycleAt,
        lastLightDecision: lastLightDecisionAudit ? { ...lastLightDecisionAudit } : null,
        lastUltraLightDecision: lastUltraLightDecisionAudit ? { ...lastUltraLightDecisionAudit } : null,
        lastLightDecisionSummary,
        lastUltraLightDecisionSummary,
        lastTradingSummary,
        lastReflectionSummary,
        lastError: lastEngineError,
        lastActivityAt,
        schedule: {
            timezone: tz,
            tradingCycleHours: config.tradingCycleHours,
            reflectionCycleHours: config.reflectionCycleHours,
            lightCycleEnabled: roleRunsLightCycles(),
            lightCycleIntervalMinutes: toPositiveInt(config.lightCycleIntervalMinutes, 1),
            ultraLightCycleEnabled: roleRunsUltraLightCycles(),
            ultraLightCycleIntervalMinutes: toPositiveInt(config.ultraLightCycleIntervalMinutes, 1),
            mainCycleCron: getMainCycleCron(),
            reflectionCron: "55 15 * * 1-5",
            weekendReviewCron: config.railwayBudgetMode ? "disabled_in_budget_mode" : getWeekendReviewCron(),
            lightCycleCron: roleRunsLightCycles() ? getLightCycleCron() : null,
            ultraLightCycleCron: roleRunsUltraLightCycles() ? getUltraLightCycleCron() : null,
        },
    };
}

function summarizeLine(text: string, maxLength: number = 180): string {
    const firstLine = text
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean) || "";
    const normalized = firstLine.replace(/\s+/g, " ");
    return normalized.length > maxLength
        ? `${normalized.slice(0, maxLength - 3)}...`
        : normalized;
}

function logScheduledResult(source: string, result: string): void {
    console.log(`?? [Trading] ${source}: ${summarizeLine(result, 260)}`);
}

function getLightModelOverride(): string | undefined {
    const raw = config.lightLlmModel?.trim();
    return raw ? raw : undefined;
}

function estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

function trimToTokenBudget(text: string, maxTokens: number): { text: string; estimatedTokens: number; trimmed: boolean } {
    const budget = Math.max(256, Math.floor(maxTokens));
    const initial = estimateTokens(text);
    if (initial <= budget) {
        return { text, estimatedTokens: initial, trimmed: false };
    }
    const safeChars = Math.max(128, budget * 4);
    const trimmedText = `${text.slice(0, safeChars)}\n\n[TRIMMED_TO_BUDGET]`;
    return { text: trimmedText, estimatedTokens: estimateTokens(trimmedText), trimmed: true };
}

function toFiniteNumber(value: string | number | undefined): number {
    const parsed = typeof value === "number" ? value : Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

function countUnprotectedPositions(
    positions: alpaca.AlpacaPosition[],
    openOrders: alpaca.AlpacaOrder[]
): number {
    return positions.filter((p) => {
        const sellOrders = openOrders.filter((o) => o.symbol === p.symbol && o.side === "sell");
        return !sellOrders.some((o) => o.type === "trailing_stop" || o.type === "stop");
    }).length;
}

function getFastCycleLabel(mode: FastCycleMode): string {
    return mode === "ultra_light" ? "Ultra Light" : "Light";
}

function getFastCycleEngineLabel(mode: FastCycleMode): "LIGHT" | "ULTRA LIGHT" {
    return mode === "ultra_light" ? "ULTRA LIGHT" : "LIGHT";
}

function isAnotherFastCycleRunning(mode: FastCycleMode): boolean {
    return mode === "ultra_light" ? lightCycleRunning : ultraLightCycleRunning;
}

function getRunningFlag(mode: FastCycleMode): boolean {
    return mode === "ultra_light" ? ultraLightCycleRunning : lightCycleRunning;
}

function setRunningFlag(mode: FastCycleMode, value: boolean): void {
    if (mode === "ultra_light") {
        ultraLightCycleRunning = value;
        return;
    }
    lightCycleRunning = value;
}

function extractMessageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part: any) => typeof part?.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n");
}

interface LightIndicatorSignals {
    mainEscalations: string[];
    lightActions: string[];
    dataWarnings: string[];
}

async function evaluateLightIndicatorSignals(
    positions: alpaca.AlpacaPosition[]
): Promise<LightIndicatorSignals> {
    const result: LightIndicatorSignals = {
        mainEscalations: [],
        lightActions: [],
        dataWarnings: [],
    };
    if (positions.length === 0) return result;

    const symbols = Array.from(new Set(positions.map((p) => p.symbol)));
    let barsBySymbol: Record<string, alpaca.AlpacaBar[]> = {};
    try {
        barsBySymbol = await alpaca.getBarsForSymbols(symbols, "1Day", 60);
    } catch (err: any) {
        result.mainEscalations.push(`indicator data fetch failed: ${err.message}`);
        return result;
    }

    for (const position of positions) {
        const bars = barsBySymbol[position.symbol] ?? [];
        if (bars.length < 20) {
            result.dataWarnings.push(`${position.symbol}: only ${bars.length} bars`);
            continue;
        }

        const indicators = scoreStock(position.symbol, bars);
        const plpc = toFiniteNumber(position.unrealized_plpc);
        const exit = checkExitCondition(indicators, plpc);

        if (exit.shouldExit) {
            result.mainEscalations.push(`${position.symbol}: ${exit.reason}`);
            continue;
        }

        const trendBreakRisk = plpc <= -0.03 && !indicators.emaCrossover && indicators.macdHist < 0;
        if (trendBreakRisk) {
            result.mainEscalations.push(
                `${position.symbol}: trend/momentum breakdown (P/L ${(plpc * 100).toFixed(2)}%, RSI ${indicators.rsi14.toFixed(1)}, MACD hist ${indicators.macdHist.toFixed(3)})`
            );
            continue;
        }

        if (exit.reason.includes("TIGHTEN")) {
            result.lightActions.push(`${position.symbol}: ${exit.reason}`);
        }
    }

    return result;
}

async function buildFallbackFastDecision(
    mode: FastCycleMode,
    positions: alpaca.AlpacaPosition[],
    openOrders: alpaca.AlpacaOrder[]
): Promise<LightDecisionResponse> {
    if (positions.length === 0) {
        return {
            decision: "SKIP",
            reason: "No open positions. Holding.",
            confidence: 1,
            handover_context: "",
        };
    }

    const takeProfitHits = positions.filter((p) => toFiniteNumber(p.unrealized_plpc) >= 0.10);
    const deepLossHits = positions.filter((p) => toFiniteNumber(p.unrealized_plpc) <= -0.10);
    const unprotectedCount = countUnprotectedPositions(positions, openOrders);
    const indicatorSignals = await evaluateLightIndicatorSignals(positions);
    const severeDataGap = indicatorSignals.dataWarnings.length >= Math.ceil(Math.max(1, positions.length) / 2);
    const actionSignals = [
        ...indicatorSignals.mainEscalations,
        ...indicatorSignals.lightActions,
    ];

    if (severeDataGap) {
        const triggers: string[] = [];
        triggers.push(`indicator data gap: ${indicatorSignals.dataWarnings.slice(0, 3).join(" | ")}`);

        return {
            decision: "MAIN",
            reason: `${getFastCycleLabel(mode)} fallback escalates due to missing indicator coverage (${triggers.join(" | ")}).`,
            confidence: 0.92,
            handover_context: triggers.join(" | "),
        };
    }

    if (takeProfitHits.length > 0 || deepLossHits.length > 0 || unprotectedCount > 0 || actionSignals.length > 0) {
        const triggers: string[] = [];
        if (takeProfitHits.length > 0) triggers.push(`+10% reached: ${takeProfitHits.map((p) => p.symbol).join(", ")}`);
        if (deepLossHits.length > 0) triggers.push(`-10% reached: ${deepLossHits.map((p) => p.symbol).join(", ")}`);
        if (unprotectedCount > 0) triggers.push(`unprotected positions: ${unprotectedCount}`);
        if (actionSignals.length > 0) {
            triggers.push(`indicator action: ${actionSignals.slice(0, 3).join(" | ")}`);
        }

        return {
            decision: "LIGHT",
            reason: `${getFastCycleLabel(mode)} fallback found actionable exit/protection work (${triggers.join(" | ")}).`,
            confidence: 0.9,
            handover_context: "",
        };
    }

    return {
        decision: "SKIP",
        reason: "Indicator scan complete (fresh API data) — no urgent trigger. Holding.",
        confidence: 0.93,
        handover_context: "",
    };
}

type CycleAction = "BUY" | "SELL" | "BUY+SELL" | "HOLD";

function buildQtyBySymbol(positions: alpaca.AlpacaPosition[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const p of positions) {
        map.set(p.symbol, toFiniteNumber(p.qty));
    }
    return map;
}

function detectCycleActionFromSnapshots(
    beforePositions: alpaca.AlpacaPosition[],
    beforeOrders: alpaca.AlpacaOrder[],
    afterPositions: alpaca.AlpacaPosition[],
    afterOrders: alpaca.AlpacaOrder[]
): CycleAction {
    const beforeQty = buildQtyBySymbol(beforePositions);
    const afterQty = buildQtyBySymbol(afterPositions);
    const symbols = new Set<string>([...beforeQty.keys(), ...afterQty.keys()]);

    let buySignal = false;
    let sellSignal = false;

    for (const symbol of symbols) {
        const before = beforeQty.get(symbol) ?? 0;
        const after = afterQty.get(symbol) ?? 0;
        if (after > before + 1e-9) buySignal = true;
        if (after < before - 1e-9) sellSignal = true;
    }

    const beforeOrderIds = new Set(beforeOrders.map((o) => o.id));
    for (const order of afterOrders) {
        if (beforeOrderIds.has(order.id)) continue;
        if (order.side === "buy") buySignal = true;
        if (order.side === "sell") sellSignal = true;
    }

    if (buySignal && sellSignal) return "BUY+SELL";
    if (buySignal) return "BUY";
    if (sellSignal) return "SELL";
    return "HOLD";
}

async function buildAlpacaEndStateSummary(
    cycleLabel: "MAIN" | "LIGHT" | "ULTRA LIGHT",
    startAccount: alpaca.AlpacaAccount,
    startPositions: alpaca.AlpacaPosition[],
    startOpenOrders: alpaca.AlpacaOrder[]
): Promise<string> {
    try {
        const [endAccount, endPositions, endOpenOrders] = await Promise.all([
            alpaca.getAccount(),
            alpaca.getPositions(),
            alpaca.getOrders("open"),
        ]);

        const action = detectCycleActionFromSnapshots(
            startPositions,
            startOpenOrders,
            endPositions,
            endOpenOrders
        );
        const equityStart = toFiniteNumber(startAccount.equity);
        const equityEnd = toFiniteNumber(endAccount.equity);
        const cashStart = toFiniteNumber(startAccount.cash);
        const cashEnd = toFiniteNumber(endAccount.cash);

        return `?? ALPACA ${cycleLabel} FINAL: ${action} | positions ${startPositions.length}->${endPositions.length} | open orders ${startOpenOrders.length}->${endOpenOrders.length} | equity $${equityStart.toFixed(2)}->$${equityEnd.toFixed(2)} | cash $${cashStart.toFixed(2)}->$${cashEnd.toFixed(2)}`;
    } catch (err: any) {
        return `?? ALPACA ${cycleLabel} FINAL: state refresh failed (${err.message})`;
    }
}

interface ParsedOrderToolAck {
    ok: boolean;
    side?: "BUY" | "SELL";
    qty?: string;
    symbol?: string;
    orderId?: string;
    status?: string;
    type?: string;
    reason?: string;
}

function firstNonEmptyLine(text: string): string {
    return text
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean) || "";
}

function parsePlaceOrderAck(result: string): ParsedOrderToolAck {
    const text = result || "";
    const ok = text.startsWith("OK:") || text.startsWith("✅");
    if (!ok) {
        return { ok: false, reason: firstNonEmptyLine(text) };
    }

    const idMatch = text.match(/^\s*ID:\s*([a-zA-Z0-9-]+)/m);
    const sideMatch = text.match(/\b(BUY|SELL)\s+([0-9.]+)x\s+([A-Z0-9.\-/]+)/);
    const statusMatch = text.match(/^\s*Status:\s*([^\n]+)/m);
    const typeMatch = text.match(/^\s*Type:\s*([^\n]+)/m);

    return {
        ok: true,
        side: (sideMatch?.[1] as "BUY" | "SELL" | undefined),
        qty: sideMatch?.[2],
        symbol: sideMatch?.[3],
        orderId: idMatch?.[1],
        status: statusMatch?.[1]?.trim(),
        type: typeMatch?.[1]?.trim(),
    };
}

function parseCancelAck(result: string): { ok: boolean; orderId?: string; reason?: string } {
    const text = result || "";
    const ok = text.startsWith("✅") || text.startsWith("OK:");
    if (!ok) {
        return { ok: false, reason: firstNonEmptyLine(text) };
    }
    const idMatch = text.match(/Order\s+([a-zA-Z0-9-]+)\s+cancelled/i);
    return { ok: true, orderId: idMatch?.[1] };
}

async function buildVerifiedExecutionSummary(
    cycleLabel: "MAIN" | "LIGHT",
    toolResults: Array<{ name: string; result: string }>
): Promise<string> {
    const placeAttempts = toolResults.filter((e) => e.name === "place_order");
    const cancelAttempts = toolResults.filter((e) => e.name === "cancel_order");

    const placedAcks = placeAttempts.map((e) => parsePlaceOrderAck(e.result));
    const cancelAcks = cancelAttempts.map((e) => parseCancelAck(e.result));

    const acceptedOrders = placedAcks.filter((a) => a.ok);
    const rejectedOrders = placedAcks.filter((a) => !a.ok);
    const cancelled = cancelAcks.filter((a) => a.ok).length;
    const cancelFailed = cancelAcks.filter((a) => !a.ok).length;

    let openOrders: alpaca.AlpacaOrder[] = [];
    let allOrders: alpaca.AlpacaOrder[] = [];
    try {
        [openOrders, allOrders] = await Promise.all([
            alpaca.getOrders("open"),
            alpaca.getOrders("all"),
        ]);
    } catch {
        // best effort verification below with whatever data we have
    }

    const openOrderIds = new Set(openOrders.map((o) => o.id));
    const allOrderIds = new Set(allOrders.map((o) => o.id));

    const acceptedLines = acceptedOrders.length > 0
        ? acceptedOrders.slice(0, 8).map((ack) => {
            const side = ack.side ?? "?";
            const qty = ack.qty ?? "?";
            const symbol = ack.symbol ?? "?";
            const type = ack.type ?? "unknown";
            const status = ack.status ?? "unknown";
            const id = ack.orderId ?? "missing-id";
            const verification = ack.orderId
                ? (openOrderIds.has(ack.orderId)
                    ? "OPEN"
                    : allOrderIds.has(ack.orderId)
                        ? "CONFIRMED_NOT_OPEN"
                        : "UNCONFIRMED")
                : "UNCONFIRMED";
            return `- ${side} ${qty}x ${symbol} | ${type} | status ${status} | id ${id} | verify ${verification}`;
        })
        : ["- none"];

    const rejectedLines = rejectedOrders.length > 0
        ? rejectedOrders.slice(0, 6).map((ack) => `- ${ack.reason || "unknown rejection"}`)
        : ["- none"];

    return [
        `VERIFIED ${cycleLabel} EXECUTION (broker-anchored):`,
        `place_order attempts: ${placeAttempts.length} | accepted: ${acceptedOrders.length} | rejected: ${rejectedOrders.length}`,
        `cancel_order attempts: ${cancelAttempts.length} | success: ${cancelled} | failed: ${cancelFailed}`,
        `Accepted orders:`,
        ...acceptedLines,
        `Rejected/blocked order attempts:`,
        ...rejectedLines,
    ].join("\n");
}

function extractJsonObject(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const source = (fenced?.[1] ?? text).trim();
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start < 0 || end <= start) {
        throw new Error("No JSON object found in light decision response.");
    }
    return source.slice(start, end + 1);
}

function parseLightDecision(raw: string): LightDecisionResponse {
    const parsed = JSON.parse(extractJsonObject(raw)) as Partial<LightDecisionResponse>;
    const decision = String(parsed.decision ?? "").toUpperCase() as LightDecision;
    if (!["MAIN", "LIGHT", "SKIP"].includes(decision)) {
        throw new Error(`Invalid light decision "${parsed.decision ?? ""}"`);
    }
    const reason = String(parsed.reason ?? "").trim();
    if (!reason) {
        throw new Error("Light decision missing reason.");
    }
    const handoverContext = String(parsed.handover_context ?? "").trim();
    const confidenceRaw = Number(parsed.confidence);
    const confidence = Number.isFinite(confidenceRaw)
        ? Math.min(1, Math.max(0, confidenceRaw))
        : 0.5;
    return {
        decision,
        reason,
        confidence,
        handover_context: handoverContext,
    };
}

function buildLightDecisionContext(
    mode: FastCycleMode,
    account: alpaca.AlpacaAccount,
    positions: alpaca.AlpacaPosition[],
    openOrders: alpaca.AlpacaOrder[]
): string {
    const deepLoss = positions.filter((p) => parseFloat(p.unrealized_plpc || "0") <= -0.04);
    const hardLoss = positions.filter((p) => parseFloat(p.unrealized_plpc || "0") <= -0.07);
    const unprotectedCount = countUnprotectedPositions(positions, openOrders);

    const positionLines = positions.length === 0
        ? "none"
        : positions
            .slice(0, 15)
            .map((p) => `${p.symbol} qty=${p.qty} plpc=${(parseFloat(p.unrealized_plpc || "0") * 100).toFixed(2)}%`)
            .join(" | ");

    const orderLines = openOrders.length === 0
        ? "none"
        : openOrders
            .slice(0, 20)
            .map((o) => `${o.side}:${o.symbol}:${o.type}:${o.status}`)
            .join(" | ");

    return [
        `[${getFastCycleLabel(mode).toUpperCase()} DECISION CONTEXT ${new Date().toISOString()}]`,
        `equity=${account.equity} cash=${account.cash} buying_power=${account.buying_power}`,
        `open_positions=${positions.length}`,
        `open_orders=${openOrders.length}`,
        `deep_loss_count=${deepLoss.length} hard_loss_count=${hardLoss.length}`,
        `unprotected_positions=${unprotectedCount}`,
        `positions=${positionLines}`,
        `orders=${orderLines}`,
        `cycle_mode=${mode}`,
        `policy=existing positions only; no new buys; one decision call only`,
    ].join("\n");
}

interface BuyCandidate {
    symbol: string;
    currentPrice: number;
    score: number;
    atr14: number;
}

function parseBuyCandidatesFromToolResult(text: string): BuyCandidate[] {
    const candidates: BuyCandidate[] = [];
    const lines = text.split("\n");
    const pattern = /^\s*([A-Z0-9.\-_/]+)\s+\[[^\]]+\]:\s+\$([0-9.]+)\s+\|\s+Score:\s+([0-9])\/6.*\|\s+ATR:\s+\$([0-9.]+)/;

    for (const line of lines) {
        const match = line.match(pattern);
        if (!match) continue;

        const symbol = match[1];
        const currentPrice = Number(match[2]);
        const score = Number(match[3]);
        const atr14 = Number(match[4]);
        if (!Number.isFinite(currentPrice) || !Number.isFinite(score) || !Number.isFinite(atr14)) continue;
        if (score < 3 || currentPrice <= 0 || atr14 <= 0) continue;

        candidates.push({ symbol, currentPrice, score, atr14 });
    }

    return candidates
        .sort((a, b) => b.score - a.score || a.currentPrice - b.currentPrice)
        .slice(0, 20);
}

function isRegularUsSession(hour: number, minute: number): boolean {
    const totalMinutes = hour * 60 + minute;
    return totalMinutes >= US_MARKET_OPEN_MINUTES && totalMinutes < US_MARKET_CLOSE_MINUTES;
}

function buildHardStopPrice(entryPrice: number, atr14: number): number {
    const atrStop = atr14 > 0 ? entryPrice - (atr14 * 2) : entryPrice * 0.95;
    const hardFloor = entryPrice * 0.93;
    return Number(Math.max(0.01, Math.max(atrStop, hardFloor)).toFixed(2));
}

function buildProfitLockStopPrice(entryPrice: number, unrealizedPlpc: number): number {
    const makerRate = getTradingFeeRate("maker");
    const takerRate = getTradingFeeRate("taker");
    const feeAndSlippageBufferPct = makerRate + takerRate + 0.0015;
    const maxSafeLockPct = Math.max(0, unrealizedPlpc - 0.004);

    let desiredLockPct = feeAndSlippageBufferPct;
    if (unrealizedPlpc >= 0.10) {
        desiredLockPct = unrealizedPlpc * 0.75;
    } else if (unrealizedPlpc >= 0.08) {
        desiredLockPct = unrealizedPlpc * 0.68;
    } else if (unrealizedPlpc >= 0.05) {
        desiredLockPct = unrealizedPlpc * 0.58;
    } else if (unrealizedPlpc >= 0.03) {
        desiredLockPct = unrealizedPlpc * 0.35;
    }

    const appliedLockPct = Math.max(feeAndSlippageBufferPct, Math.min(desiredLockPct, maxSafeLockPct));
    return Number(Math.max(0.01, entryPrice * (1 + appliedLockPct)).toFixed(2));
}

function getStopPriceFromOrder(order: alpaca.AlpacaOrder): number {
    if (order.type !== "stop") return 0;
    return toFiniteNumber(order.stop_price);
}

function getAutoDeployMinScore(): number {
    const minScore = Math.floor(config.autoDeployMinScore);
    if (!Number.isFinite(minScore)) return 4;
    return Math.min(6, Math.max(3, minScore));
}

function getAutoDeployLimitMultiplier(): number {
    const rawBps = Number.isFinite(config.autoDeployLimitBufferBps) ? config.autoDeployLimitBufferBps : 25;
    const clampedBps = Math.min(150, Math.max(0, rawBps));
    return 1 + (clampedBps / 10000);
}

async function ensureDownsideProtection(
    positions: alpaca.AlpacaPosition[],
    openOrders: alpaca.AlpacaOrder[],
    source: string
): Promise<string[]> {
    const actions: string[] = [];

    for (const position of positions) {
        const symbol = position.symbol;
        const symbolSellOrders = openOrders.filter((o) => o.symbol === symbol && o.side === "sell");
        const hasProtective = symbolSellOrders.some((o) => o.type === "trailing_stop" || o.type === "stop");
        if (hasProtective) continue;

        for (const order of symbolSellOrders) {
            try {
                await alpaca.cancelOrder(order.id);
                actions.push(`${source}: CANCEL ${order.type} SELL ${order.qty}x ${symbol} (replace with protective stop)`);
                const idx = openOrders.findIndex((o) => o.id === order.id);
                if (idx >= 0) openOrders.splice(idx, 1);
            } catch (err: any) {
                actions.push(`${source}: FAILED cancel ${order.type} on ${symbol} (${err.message})`);
            }
        }

        let refreshedPosition = position;
        try {
            refreshedPosition = await alpaca.getPosition(symbol);
        } catch {
            // best effort
        }

        const qtyHeld = Math.floor(parseFloat(refreshedPosition.qty || "0"));
        const qtyAvailable = Math.floor(parseFloat((refreshedPosition as any).qty_available ?? refreshedPosition.qty ?? "0"));
        const protectiveQty = qtyAvailable > 0 ? qtyAvailable : qtyHeld;
        if (!Number.isFinite(protectiveQty) || protectiveQty <= 0) {
            actions.push(`${source}: ${symbol} has no sellable quantity for protective stop`);
            continue;
        }

        const entryPrice = parseFloat(refreshedPosition.avg_entry_price || "0");
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            actions.push(`${source}: missing entry price for ${symbol}, skip protective stop`);
            continue;
        }

        let atr14 = 0;
        try {
            const bars = await alpaca.getBars(symbol, "1Day", 60, { allowStale: true });
            if (bars.length >= 20) {
                atr14 = scoreStock(symbol, bars).atr14;
            }
        } catch {
            // best effort
        }

        const stopPrice = buildHardStopPrice(entryPrice, atr14);

        try {
            const stopOrder = await alpaca.placeOrder({
                symbol,
                qty: protectiveQty,
                side: "sell",
                type: "stop",
                stop_price: stopPrice,
                time_in_force: "gtc",
            });
            openOrders.push(stopOrder);
            logTrade(
                symbol,
                "sell",
                protectiveQty,
                stopPrice,
                "stop",
                stopOrder.id,
                `${source} auto-protective stop @ $${stopPrice}${atr14 > 0 ? ` (ATR $${atr14.toFixed(2)})` : ""}`,
                stopOrder.status
            );
            actions.push(`${source}: STOP ${protectiveQty}x ${symbol} @ $${stopPrice}`);
        } catch (err: any) {
            actions.push(`${source}: FAILED protective stop for ${symbol} (${err.message})`);
        }
    }

    return actions;
}

async function ensureProfitLockProtection(
    positions: alpaca.AlpacaPosition[],
    openOrders: alpaca.AlpacaOrder[],
    source: string
): Promise<string[]> {
    const actions: string[] = [];

    for (const position of positions) {
        const plpc = toFiniteNumber(position.unrealized_plpc);
        if (plpc < 0.03) continue;

        const entryPrice = toFiniteNumber(position.avg_entry_price);
        if (entryPrice <= 0) continue;

        const symbol = position.symbol;
        const targetStopPrice = buildProfitLockStopPrice(entryPrice, plpc);
        const symbolSellOrders = openOrders.filter((o) => o.symbol === symbol && o.side === "sell");

        const existingProtected = symbolSellOrders.some((order) => {
            if (order.type === "stop" && getStopPriceFromOrder(order) >= (targetStopPrice - 0.01)) return true;
            return false;
        });
        if (existingProtected) continue;

        for (const order of symbolSellOrders) {
            if (order.type !== "stop" && order.type !== "trailing_stop") continue;
            try {
                await alpaca.cancelOrder(order.id);
                actions.push(`${source}: CANCEL ${order.type} SELL ${order.qty}x ${symbol} (upgrade to profit-lock stop)`);
                const idx = openOrders.findIndex((o) => o.id === order.id);
                if (idx >= 0) openOrders.splice(idx, 1);
            } catch (err: any) {
                actions.push(`${source}: FAILED cancel ${order.type} on ${symbol} (${err.message})`);
            }
        }

        let refreshedPosition = position;
        try {
            refreshedPosition = await alpaca.getPosition(symbol);
        } catch {
            // best effort
        }

        const qtyHeld = Math.floor(toFiniteNumber(refreshedPosition.qty));
        const qtyAvailable = Math.floor(toFiniteNumber((refreshedPosition as any).qty_available ?? refreshedPosition.qty));
        const stopQty = qtyAvailable > 0 ? qtyAvailable : qtyHeld;
        if (!Number.isFinite(stopQty) || stopQty <= 0) {
            actions.push(`${source}: ${symbol} has no sellable quantity for profit-lock stop`);
            continue;
        }

        try {
            const stopOrder = await alpaca.placeOrder({
                symbol,
                qty: stopQty,
                side: "sell",
                type: "stop",
                stop_price: targetStopPrice,
                time_in_force: "gtc",
            });
            openOrders.push(stopOrder);
            logTrade(
                symbol,
                "sell",
                stopQty,
                targetStopPrice,
                "stop",
                stopOrder.id,
                `${source} profit-lock stop @ $${targetStopPrice} (P/L ${(plpc * 100).toFixed(2)}%)`,
                stopOrder.status
            );
            actions.push(`${source}: PROFIT LOCK STOP ${stopQty}x ${symbol} @ $${targetStopPrice}`);
        } catch (err: any) {
            actions.push(`${source}: FAILED profit-lock stop for ${symbol} (${err.message})`);
        }
    }

    return actions;
}

async function runAutoDeploymentBuys(
    cycleToolResults: Array<{ name: string; result: string }>
): Promise<string[]> {
    if (!config.autoDeployBuysEnabled) return [];

    const account = await alpaca.getAccount();
    const positions = await alpaca.getPositions();
    const equity = parseFloat(account.equity || "0");
    const cash = parseFloat(account.cash || "0");
    if (equity <= 0) return [];

    const cashRatio = cash / equity;
    if (cashRatio <= config.autoDeployCashThreshold) return [];
    if (positions.length >= MAX_OPEN_POSITIONS) return [];

    const openOrders = await alpaca.getOrders("open");
    const openBuyOrders = openOrders.filter((o) => o.side === "buy");
    const maxPendingBuyOrders = Math.max(1, toPositiveInt(config.autoDeployMaxPendingBuyOrders, 3));
    if (openBuyOrders.length >= maxPendingBuyOrders) return [];

    const heldSymbols = new Set(positions.map((p) => p.symbol));
    const openBuySymbols = new Set(openBuyOrders.map((o) => o.symbol));
    const exposureSymbols = new Set<string>([...heldSymbols, ...openBuySymbols]);

    const maxNewBuys = Math.min(
        toPositiveInt(config.autoDeployBuysPerCycle, 2),
        MAX_OPEN_POSITIONS - exposureSymbols.size,
        maxPendingBuyOrders - openBuyOrders.length
    );
    if (maxNewBuys <= 0) return [];

    const minScore = getAutoDeployMinScore();
    const limitMultiplier = getAutoDeployLimitMultiplier();

    const screenResultText = cycleToolResults.find(r => r.name === "screen_watchlist")?.result || "";
    let candidates = parseBuyCandidatesFromToolResult(screenResultText).filter((c) => c.score >= minScore);
    if (candidates.length === 0) {
        const screen = await runWatchlistScreen();
        candidates = screen.buySignals
            .map((r) => ({ symbol: r.symbol, currentPrice: r.currentPrice, score: r.score, atr14: r.atr14 }))
            .filter((r) => r.score >= minScore && r.currentPrice > 0 && r.atr14 > 0)
            .sort((a, b) => b.score - a.score || a.currentPrice - b.currentPrice)
            .slice(0, 20);
    }

    if (candidates.length === 0) return [];

    let remainingCash = cash;
    const actions: string[] = [];
    const tzStatus = getBotActivityStatus();
    const extendedHours = !isRegularUsSession(tzStatus.hour, tzStatus.minute);

    for (const candidate of candidates) {
        if (actions.length >= maxNewBuys) break;
        if (heldSymbols.has(candidate.symbol)) continue;

        const hasOpenBuy = openBuySymbols.has(candidate.symbol);
        if (hasOpenBuy) continue;

        const sectorCheck = isSectorLimitReached(Array.from(exposureSymbols), candidate.symbol, 2);
        if (sectorCheck.blocked) continue;

        try {
            const bars = await alpaca.getBars(candidate.symbol, "1Day", 60, { allowStale: true });
            if (bars.length < 20) continue;
            const indicators = scoreStock(candidate.symbol, bars);
            const verdict = validateBuySetup(indicators, minScore);
            if (!verdict.valid) {
                continue;
            }
        } catch {
            continue;
        }

        const riskPerShare = Math.max(0.01, candidate.atr14 * 2);
        const qtyByRisk = Math.floor((equity * 0.02) / riskPerShare);
        const qtyByCap = Math.floor((equity * 0.10) / candidate.currentPrice);
        const limitPrice = Number((candidate.currentPrice * limitMultiplier).toFixed(2));
        const takerFeeRate = getTradingFeeRate("taker");
        const qtyByCash = Math.floor(remainingCash / (limitPrice * (1 + takerFeeRate)));
        const qty = Math.min(qtyByRisk, qtyByCap, qtyByCash);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        try {
            const buyOrder = await alpaca.placeOrder({
                symbol: candidate.symbol,
                qty,
                side: "buy",
                type: "limit",
                limit_price: limitPrice,
                time_in_force: "day",
                extended_hours: extendedHours || undefined,
            });
            logTrade(
                candidate.symbol,
                "buy",
                qty,
                limitPrice,
                "limit",
                buyOrder.id,
                `Auto-deploy buy (cash ${(cashRatio * 100).toFixed(1)}%, score ${candidate.score}/6, ATR $${candidate.atr14.toFixed(2)})`,
                buyOrder.status
            );

            const filledQty = Math.floor(parseFloat(buyOrder.filled_qty || "0"));
            if (filledQty > 0) {
                const protectiveQty = Math.min(qty, filledQty);
                const trailPrice = Math.max(0.01, Number((candidate.atr14 * 2).toFixed(2)));
                let protectionPlaced = false;
                try {
                    const stopOrder = await alpaca.placeOrder({
                        symbol: candidate.symbol,
                        qty: protectiveQty,
                        side: "sell",
                        type: "trailing_stop",
                        trail_price: String(trailPrice),
                        time_in_force: "gtc",
                    });
                    logTrade(
                        candidate.symbol,
                        "sell",
                        protectiveQty,
                        null,
                        "trailing_stop",
                        stopOrder.id,
                        `Auto-deploy protective trailing stop ($${trailPrice})`,
                        stopOrder.status
                    );
                    protectionPlaced = true;
                } catch {
                    // fallback below
                }

                if (!protectionPlaced) {
                    try {
                        const stopPrice = buildHardStopPrice(limitPrice, candidate.atr14);
                        const stopOrder = await alpaca.placeOrder({
                            symbol: candidate.symbol,
                            qty: protectiveQty,
                            side: "sell",
                            type: "stop",
                            stop_price: stopPrice,
                            time_in_force: "gtc",
                        });
                        logTrade(
                            candidate.symbol,
                            "sell",
                            protectiveQty,
                            stopPrice,
                            "stop",
                            stopOrder.id,
                            `Auto-deploy protective hard stop @ $${stopPrice}`,
                            stopOrder.status
                        );
                        protectionPlaced = true;
                    } catch {
                        // best effort
                    }
                }

                actions.push(
                    protectionPlaced
                        ? `BUY ${qty}x ${candidate.symbol} @ $${limitPrice} (score ${candidate.score}/6, stop active)`
                        : `BUY ${qty}x ${candidate.symbol} @ $${limitPrice} filled (?? stop placement failed)`
                );
            } else {
                actions.push(`BUY ${qty}x ${candidate.symbol} @ $${limitPrice} submitted (protection deferred until fill)`);
            }

            const notional = qty * limitPrice;
            const estimatedFee = estimateTradingFeeUsd(notional, "taker");
            remainingCash = Math.max(0, remainingCash - notional - estimatedFee);
            openBuySymbols.add(candidate.symbol);
            exposureSymbols.add(candidate.symbol);
        } catch {
            // skip this candidate
        }
    }

    return actions;
}

export interface BotActivityStatus {
    active: boolean;
    highActivity: boolean;
    hour: number;
    minute: number;
}

/**
 * Check if current wall-clock time is inside regular US market hours
 * (Mon-Fri, 09:30-16:00 America/New_York).
 */
export function getBotActivityStatus(): BotActivityStatus {
    const tz = US_MARKET_TIMEZONE;
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
    });
    
    const parts = formatter.formatToParts(now);
    const weekdayPart = parts.find(p => p.type === "weekday")?.value ?? "";
    const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekdayPart);
    const hourPart = parts.find(p => p.type === "hour")?.value;
    const minutePart = parts.find(p => p.type === "minute")?.value;
    
    const hour = parseInt(hourPart || "0", 10);
    const minute = parseInt(minutePart || "0", 10);
    const totalMinutes = hour * 60 + minute;

    const active = isWeekday
        && totalMinutes >= US_MARKET_OPEN_MINUTES
        && totalMinutes < US_MARKET_CLOSE_MINUTES;
    const highActivity = active;

    return { active, highActivity, hour, minute };
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

type ReflectionMode = "daily" | "weekly";

interface ReflectionSections {
    lessons: string;
    strategyAdjustments: string;
}

function extractMarkdownSection(text: string, heading: string): string {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`###\\s+${escapedHeading}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|$)`, "i");
    const match = regex.exec(text);
    return match?.[1]?.trim() || "";
}

function extractReflectionSections(text: string): ReflectionSections {
    const lessons = extractMarkdownSection(text, "LESSONS LEARNED");
    const strategyAdjustments = extractMarkdownSection(text, "STRATEGY ADJUSTMENTS");
    return {
        lessons: lessons || text.slice(0, 2000),
        strategyAdjustments,
    };
}

function acquireEngineLock(): boolean {
    try {
        const dir = path.dirname(ENGINE_LOCK_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Atomic lock create to avoid race conditions on rapid restarts.
        try {
            const fd = fs.openSync(ENGINE_LOCK_PATH, "wx");
            fs.writeFileSync(fd, String(process.pid), "utf-8");
            fs.closeSync(fd);
            return true;
        } catch (err: any) {
            if (err?.code !== "EEXIST") throw err;
        }

        const raw = fs.readFileSync(ENGINE_LOCK_PATH, "utf-8").trim();
        const existingPid = Number(raw);
        if (existingPid && existingPid !== process.pid && isProcessAlive(existingPid)) {
            console.error(`? Trading engine already running in PID ${existingPid}. Refusing second instance.`);
            return false;
        }

        // Stale lock file: clean up and retry once.
        try {
            fs.unlinkSync(ENGINE_LOCK_PATH);
        } catch {
            // best effort
        }
        const fd = fs.openSync(ENGINE_LOCK_PATH, "wx");
        fs.writeFileSync(fd, String(process.pid), "utf-8");
        fs.closeSync(fd);
        return true;
    } catch (err: any) {
        console.error("?? Failed to acquire trading engine lock:", err.message);
        return false;
    }
}

function releaseEngineLock(): void {
    try {
        if (!fs.existsSync(ENGINE_LOCK_PATH)) return;
        const raw = fs.readFileSync(ENGINE_LOCK_PATH, "utf-8").trim();
        const lockPid = Number(raw);
        if (lockPid === process.pid) {
            fs.unlinkSync(ENGINE_LOCK_PATH);
        }
    } catch {
        // best effort
    }
}

function registerEngineSignalHooks(): void {
    if (engineSignalHooksRegistered) return;
    process.once("exit", releaseEngineLock);
    process.once("SIGINT", releaseEngineLock);
    process.once("SIGTERM", releaseEngineLock);
    engineSignalHooksRegistered = true;
}

// â”€â”€ System Prompts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MINI_ACCOUNT_PROMPT_SUFFIX = config.alpacaAllowFractionalShares ? `

MICRO ACCOUNT MODE (IMPORTANT):
  â€¢ This runtime may trade a very small account using FRACTIONAL SHARES.
  â€¢ If a position size is below 1 share, use decimal qty with up to 6 decimals.
  â€¢ Fractional orders on Alpaca must use MARKET orders only.
  â€¢ Do NOT place fractional LIMIT, STOP, TRAILING STOP, or extended-hours orders.
  â€¢ For very small accounts, prefer simple market entries and simple market exits.
  â€¢ You are allowed to hold fewer positions and keep more cash if position sizing is too small.
  â€¢ If the setup is weak or fees/slippage would dominate, SKIP the trade.
` : "";

const TRADING_CASH_LOW_RULE = config.alpacaAllowFractionalShares
    ? `  â†’ If cash is very low (<$3), stop and do not look for new buys.`
    : `  â†’ If cash is very low (<$500), stop and do not look for new buys.`;

const TRADING_STEP3_EXECUTION_RULES = config.alpacaAllowFractionalShares
    ? `  â†’ For each passing candidate:
    1. Get ATR from the screener output
    2. Calculate risk_per_share = 2 Ã— ATR
    3. Calculate qty from risk, but you MAY use decimal qty up to 6 decimals
    4. Cap total position to â‰¤ 10% of equity
    5. Use place_order with side:"buy", type:"market"
    6. Do NOT place trailing_stop, stop, or take-profit orders for fractional positions
    7. Re-check exits in later cycles using market sells if needed`
    : `  â†’ For each passing candidate:
    1. Get ATR from the screener output
    2. Calculate risk_per_share = 2 Ã— ATR
    3. Calculate qty = floor(equity Ã— 0.02 / risk_per_share)
    4. Cap qty so total position â‰¤ 10% of equity
    5. Set limit_price = current_price Ã— 1.002 (0.2% ABOVE current price to ensure fast fill)
    6. Call place_order with side:"buy", type:"limit", limit_price
    7. IMMEDIATELY place trailing_stop: side:"sell", type:"trailing_stop", trail_price: round(2 Ã— ATR, 2)
    8. IMMEDIATELY place take-profit: side:"sell", type:"limit", limit_price: round(entry Ã— 1.10, 2) (10% target)`;

const TRADING_SYSTEM_PROMPT = `You are TradingClaw v3.0 â€” an autonomous stock trading bot running on Alpaca PAPER trading.

â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
STRATEGY: Multi-Factor Scoring + ATR-Based Risk Management
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

ENTRY RULES â€” BUY when SCORE â‰¥ 3/6:
  The screener uses a multi-factor scoring system (0-6 points):
  â€¢ RSI(14) < 30: +2pts (deeply oversold)
  â€¢ RSI(14) 30-45: +1pt (moderately oversold)
  â€¢ EMA50 > EMA200: +1pt (uptrend confirmed)
  â€¢ Volume > 1.5Ã— 20-day avg: +1pt (institutional interest)
  â€¢ MACD line > Signal line: +1pt (momentum crossover)
  â€¢ MACD Histogram > 0: +1pt (rising momentum)
  â†’ BUY when score â‰¥ 3

EXIT RULES â€” SELL when ANY ONE is true:
  ðŸ”´ RSI(14) > 70           â†’ overbought, exit immediately
  ðŸ”´ ATR-based stop-loss     â†’ 2Ã—ATR below entry (dynamic, ~3-7% depending on volatility)
  ðŸ”´ Hard floor stop-loss    â†’ -7% max (absolute safety net)
  ðŸŸ¢ Unrealized P/L â‰¥ +10%  â†’ hard take-profit
  ðŸŸ¢ Exit check says "TIGHTEN" â†’ tighten trailing stop to 1.5Ã—ATR
  (Note: Trailing Stops also secure profits automatically)

â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
POSITION SIZING (ATR-Based):
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  â€¢ Risk per trade: 2% of total equity
  â€¢ Trading fees are volume-tiered (maker/taker) based on 30-day USD volume. Include entry+exit fees in expected reward/risk.
  â€¢ Calculate: risk_per_share = 2 Ã— ATR (from screener)
  â€¢ Calculate: qty = floor(equity Ã— 0.02 / risk_per_share)
  â€¢ Cap: Maximum 10% of portfolio per single position
  â€¢ Cap: Maximum 7 open positions at any time (target: 5-7)
  â€¢ LIMIT orders with limit price within **0.2%** of current price (tight spread for fast fills)
  â€¢ For exits, use MARKET orders (speed over price)
  â€¢ **EXTENDED HOURS (Pre-Market/After-Hours):** You MUST set \`extended_hours: true\` for all limit orders placed outside 09:30-16:00 America/New_York. Always use \`time_in_force: "day"\` for extended-hours limit orders.
  â€¢ **VOLUME CHECK:** In US Pre-Market (before 09:30 ET), only buy if volume is already significant (check news/data).

TRAILING STOP RULES:
  â€¢ ALWAYS use trail_price (NOT trail_percent) â€” set trail_price = round(2 Ã— ATR, 2)
  â€¢ ALWAYS set time_in_force to "gtc" (good-til-cancelled) so trailing stops survive overnight
  â€¢ Place the trailing stop IMMEDIATELY after each buy order
  â€¢ ALSO place a take-profit LIMIT SELL at +10% above entry price (GTC)

BREAK-EVEN STOP RULE (IMPORTANT â€” protects against losing money):
  â€¢ In STEP 1, for each profitable position (P/L â‰¥ +3%):
    1. Check get_orders for existing trailing_stop orders on that symbol
    2. Cancel the old trailing stop
    3. Place a NEW trailing_stop with trail_price = round(current_price - avg_entry_price, 2)
       This sets the effective stop exactly at your entry price (break-even)
    4. As the price rises, the stop follows â€” but it can NEVER drop below your entry price
  â€¢ This guarantees: once a stock is +3% in profit, you lock at least break-even plus fee buffer on pullbacks

  TIGHTEN STOP RULE (for positions with P/L â‰¥ +5%):
  â€¢ When the exit check returns "TIGHTEN": cancel old trailing stop, place new one with trail_price = round(1.5 Ã— ATR, 2)
  â€¢ This locks in more profit by using a tighter trailing distance

â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
SECTOR DIVERSIFICATION:
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  â€¢ Maximum 2 positions in the SAME sector (Technology, Healthcare, Financials, etc.)
  â€¢ The screener output includes [Sector] tags for each stock
  â€¢ Before buying, check your existing positions' sectors and skip if limit reached
  â€¢ Prefer spreading across different sectors for lower correlation risk

â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
CASH UTILIZATION (MANDATORY):
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  â€¢ Target: â‰¥60% of equity should be INVESTED at all times
  â€¢ If cash > 40% of equity AND you have fewer than 5 positions: YOU MUST find and BUY more stocks
  â€¢ Screen aggressively â€” buy the top 2-3 scoring stocks from the screener
  â€¢ Do NOT sit on idle cash â€” uninvested money earns nothing

â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
DAILY LOSS GUARD RESPONSE MODE (WHEN ACTIVE):
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  â€¢ DO NOT open new BUY positions while the guard is active.
  â€¢ Run defensive management only: exits, stop updates, and risk reduction.
  â€¢ For each open position, run deep news check with at least TWO web_search queries:
    - "[SYMBOL] stock news today"
    - "[SYMBOL] downgrade earnings guidance lawsuit crash risk"
  â€¢ If technical exits + bad catalyst align, exit immediately (market sell).
  â€¢ If news risk is unclear, tighten stops instead of adding risk.
  â€¢ Keep queries non-duplicative and stop searching once you have enough evidence to act.
  â€¢ You may discuss possible next-day scale-in (averaging down) ideas in the summary, but NEVER place buy orders during active guard.

â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
MANDATORY CYCLE WORKFLOW â€” follow these steps in order:
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

STEP 1 â€” ACCOUNT & OPEN TRADES CHECK
  â†’ Call get_account to check your cash and PDT status.
  â†’ Call get_positions to review your current open trades.
  â†’ Call get_orders to review any pending orders. (Orders older than 8 hours are automatically cancelled by the system before you run).
  â†’ For EACH open position, call calculate_indicators. If the exit check says EXIT â†’ call place_order (side: "sell").
  â†’ For EACH profitable position (P/L â‰¥ +3%): Apply the BREAK-EVEN STOP RULE above.
  â†’ For EACH position with P/L â‰¥ +5%: Apply the TIGHTEN STOP RULE above.
${TRADING_CASH_LOW_RULE}

STEP 2 â€” SCREEN & RESEARCH THE NET
  â†’ Call screen_watchlist. Focus ONLY on stocks marked ðŸŸ¢ BUY (score â‰¥ 3).
  â†’ Higher scores are BETTER â€” prioritize score 5-6 stocks over score 3 stocks.
  â†’ Research ONLY the top 3 BUY candidates by score unless you still need more names to reach portfolio targets.
  â†’ For each candidate under review, first call web_search with "[Symbol] stock news today".
  â†’ Run the second risk query web_search "[Symbol] downgrade earnings guidance lawsuit" ONLY if the first query did not already disqualify the stock.
  â†’ Check the search results. If there is bad news (downgrades, lawsuits, bad earnings), DO NOT BUY.
  â†’ Do NOT repeat web_search for the same symbol with near-duplicate wording.
  â†’ DO NOT buy a stock you sold within the last 24 hours (no re-entry cooldown).
  â†’ CHECK SECTOR: if you already have 2 positions in that sector, SKIP and move to next candidate.

STEP 3 â€” DECIDE INVESTMENTS & PRICES (ATR-Based Sizing)
${TRADING_STEP3_EXECUTION_RULES}

STEP 4 â€” SUMMARIZE
  â†’ After all orders, output a final summary: trades made, P/L captured on exits, and why.
  â†’ Include a brief REFLECTION: what you did wrong, what to improve in the next cycle.
  â†’ If daily loss guard is active, include "NEXT DAY SCALE-IN WATCHLIST" (ideas only, no orders today).
  â†’ Include sector breakdown of current portfolio.
  â†’ If you already have enough information to act, STOP researching and finalize.
  â†’ DO NOT call any more tools after the summary. Your final message ends the cycle.

â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
RULES:
  â€¢ Paper trading only â€” no real money at risk
  â€¢ Fees are volume-tiered maker/taker; if uncertain, assume taker fee for conservative sizing
  â€¢ NO leverage, NO margin, NO short selling, NO options
  â€¢ Stick to the rules above â€” do not improvise entry criteria
  â€¢ If the screener finds 0 BUY signals: HOLD and say so â€” do not force a trade
  â€¢ Be decisive and fast â€” this is an algorithmic execution, not speculation
  â€¢ PDT LIMIT: If day_trade_count â‰¥ 3 this week, DO NOT make any day trades (buy+sell same stock same day)
  â€¢ SECTOR LIMIT: Max 2 positions per sector â€” check before every buy
  â€¢ CASH RULE: If cash > 40% of equity, you MUST actively look for new positions
  â€¢ DAILY LOSS LIMIT: If daily drawdown guard is active, DO NOT place any new BUY orders
  â€¢ During daily loss guard, prioritize exits + stop tightening + web news risk checks on current holdings

CRITICAL TOOL CALLING RULE:
You CANNOT see market data or watchlist results yet. You MUST actually call the tools (e.g. \`screen_watchlist\`, \`get_account\`) to get real data. DO NOT hallucinate prices, scores, or stocks. Always start your first response by calling \`get_account\` and \`get_positions\`, then choose \`screen_watchlist\` for normal mode or immediate position/news defense if daily loss guard is active.
${MINI_ACCOUNT_PROMPT_SUFFIX}
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•`;

const LIGHT_DECISION_SYSTEM_PROMPT = `You are a professional algorithmic US stock day-trading decision gate.
You are risk-averse, data-first, and never emotional.

Use this framework in order:
1) Trend/momentum
2) Volume confirmation
3) Support/resistance proximity
4) Risk/volatility (range behavior)
5) Decide only if at least two factors are clear

Internal action mapping for this engine:
- BUY intent -> MAIN (escalate to full cycle, because fast cycle must not open new buys)
- SELL intent -> LIGHT (run deterministic exit/protection now)
- HOLD intent -> SKIP

Hard rules:
- If signals are mixed or confidence < 0.65 -> SKIP
- If risk is high and confidence < 0.80 -> SKIP
- No new buy orders in fast cycle

Return STRICT JSON only:
{
  "decision": "MAIN|LIGHT|SKIP",
  "reason": "one concise data-based sentence",
  "confidence": 0.0,
  "handover_context": "what main should continue with"
}`;

const REFLECTION_SYSTEM_PROMPT = `You are TradingClaw performing a daily self-reflection on your trading performance.

TASK: Analyze your recent trades and trading performance over the last 24 hours.

You will be given:
- Your current account status
- Your open positions
- A log of recent trades

ANALYZE THE DATA AND OUTPUT EXACTLY THESE THREE SECTIONS:

### PERFORMANCE SUMMARY
Provide a concise overview of the performance, including the overall P/L assessment.

### LESSONS LEARNED
1. Which trades were profitable and why?
2. Which trades lost money and what went wrong?
3. What patterns are visible in winning vs losing trades?
4. What market conditions affected performance?

### STRATEGY ADJUSTMENTS
Based on the lessons above, what specific, actionable changes should you make for the next trading cycle?

Include these mandatory points inside your adjustments:
- Which losing positions should be reduced/exited faster if negative news accelerates a crash.
- Where a cautious next-day scale-in (averaging down) could make sense, and what confirmation is required first.
- Which web/news checks must be repeated before taking new risk.

Be honest and analytical. Your "LESSONS LEARNED" and "STRATEGY ADJUSTMENTS" will be directly injected into your next trading cycle's prompt.`;

const WEEKEND_REVIEW_SYSTEM_PROMPT = `You are TradingClaw performing a weekend weekly improvement review.

TASK: Analyze the full trading week and decide what must improve before the next market week begins.

You will be given:
- Current account status
- Current open positions
- Trades from the last 7 days
- Recent cycle summaries from the last 7 days

ANALYZE THE DATA AND OUTPUT EXACTLY THESE FOUR SECTIONS:

### WEEKLY PERFORMANCE SUMMARY
Summarize the week: realized behavior, quality of decisions, risk handling, and overall P/L quality.

### LESSONS LEARNED
1. Which decisions helped performance this week and why?
2. Which decisions hurt performance and why?
3. Which recurring mistakes, delays, or overreactions appeared?
4. Which market conditions or symbols deserve more caution next week?

### STRATEGY ADJUSTMENTS
Give specific rule changes or behavior changes for next week.

### NEXT WEEK PLAN
State concrete priorities for Monday and the next trading week:
- what to repeat
- what to stop doing
- what to monitor early
- where a cautious scale-in could make sense
- what news/risk checks must be mandatory before new buys

Be honest, critical, and specific. Optimize for better execution next week, not for self-justification.`;

// â”€â”€ Trading Cycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runTradingCycle(handover?: TradingCycleHandover): Promise<string> {
    if (tradingCycleRunning) {
        const msg = "? [Trading] Previous trading cycle still running. Skipping overlapping cycle.";
        console.log(msg);
        return msg;
    }

    const status = getBotActivityStatus();
    if (!status.active) {
        const msg = `?? [Trading] Outside US market hours (${status.hour}:${status.minute} ET). Bot is offline until 09:30 ET.`;
        console.log(msg);
        return msg;
    }

    tradingCycleRunning = true;
    fastCycleIdleUntilMs = 0;
    lastEngineError = null;
    if (lightCycleRunning || ultraLightCycleRunning) {
        lightCycleAbortRequested = true;
        console.log("[Trading] Full cycle priority: requesting fast cycle to yield.");
        const yielded = await waitForFastCycleYield(LIGHT_CYCLE_YIELD_TIMEOUT_MS);
        if (yielded) {
            console.log("[Trading] Fast cycle yielded to full cycle.");
        } else {
            console.warn("[Trading] Fast cycle did not yield in time. Continuing with full-cycle priority.");
        }
        lightCycleAbortRequested = false;
    }
    setTradingExecutionContext("default");
    const cycleId = ++tradingCycleSequence;
    currentTradingCycleId = cycleId;
    const cycleStartedAt = Date.now();
    const cycleStartedAtIso = new Date(cycleStartedAt).toISOString();
    lastTradingCycleStartedAt = cycleStartedAtIso;
    touchRuntimeActivity(cycleStartedAtIso);
    let cycleToolCallCount = 0;
    let cycleToolResultCount = 0;
    let lastToolName = "none";
    let progressInterval: NodeJS.Timeout | null = null;
    let finalTradingResult: string | null = null;

    console.log(`?? [Trading][Cycle ${cycleId}] Starting autonomous trading cycle... ${status.highActivity ? "(HIGH ACTIVITY MODE ??)" : ""}`);

    try {
        progressInterval = setInterval(() => {
            const elapsedSec = Math.round((Date.now() - cycleStartedAt) / 1000);
            console.log(
                `? [Trading][Cycle ${cycleId}] Still running (${elapsedSec}s) | tool calls: ${cycleToolCallCount}, tool results: ${cycleToolResultCount}, last tool: ${lastToolName}`
            );
        }, 30_000);

        // --- 8-HOUR CANCELLATION POLICY ---
        // Fetch open orders and cancel those older than 8 hours
        const openOrders = await alpaca.getOrders("open");
        const nowMs = Date.now();
        const eightHoursMs = 8 * 60 * 60 * 1000;
        let cancelledCount = 0;
        const remainingOrders: alpaca.AlpacaOrder[] = [];

        for (const order of openOrders) {
            const createdAtMs = new Date(order.created_at).getTime();
            if (nowMs - createdAtMs > eightHoursMs) {
                console.log(`â±ï¸ [Trading] Cancelling order ${order.id} for ${order.symbol} â€” older than 8 hours.`);
                try {
                    await alpaca.cancelOrder(order.id);
                    cancelledCount++;
                } catch (e: any) {
                    console.error(`âš ï¸ Failed to cancel order ${order.id}:`, e.message);
                }
            } else {
                remainingOrders.push(order);
            }
        }

        if (cancelledCount > 0) {
            console.log(`âœ… [Trading] Automatically cancelled ${cancelledCount} stale orders (>8h).`);
            // Wait a moment for buying power / cash to settle after cancellation
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // Build minimal context with current state
        let account = await alpaca.getAccount();
        let positions = await alpaca.getPositions();
        const drawdownStatus = evaluateDailyDrawdown(parseFloat(account.equity));
        const lastReflection = getLatestReflection();
        const toolDefs = await getToolDefinitions();
        const toolNames = new Set(
            toolDefs
                .filter(t => t.type === "function")
                .map(t => t.function.name)
        );
        const requiredTools = [
            "get_account",
            "get_positions",
            "screen_watchlist",
            "calculate_indicators",
            "place_order",
        ];
        const missingTools = requiredTools.filter(name => !toolNames.has(name));

        if (missingTools.length > 0) {
            const missingMsg = `âŒ Trading cycle aborted: missing required tools (${missingTools.join(", ")}).`;
            console.error(`[Trading] ${missingMsg}`);
            logCycle(
                "trading",
                missingMsg,
                JSON.stringify(positions),
                JSON.stringify({ equity: account.equity, cash: account.cash, buying_power: account.buying_power })
            );
            finalTradingResult = missingMsg;
            return missingMsg;
        }

        // Hard risk guard: daily drawdown stop.
        // If the account is below the daily loss limit, cancel all open BUY orders and block new buys for the day.
        const riskActions: string[] = [];
        if (drawdownStatus.newlyBreached) {
            console.warn(
                `?? [Trading] Daily loss limit hit (${drawdownStatus.drawdownAmount.toFixed(2)} <= -${drawdownStatus.limitAmount.toFixed(2)}).`
            );
        }
        if (drawdownStatus.breached) {
            for (const order of [...remainingOrders]) {
                if (order.side !== "buy") continue;
                try {
                    await alpaca.cancelOrder(order.id);
                    riskActions.push(`CANCEL BUY ${order.qty}x ${order.symbol} (daily loss guard)`);
                    const idx = remainingOrders.findIndex((o) => o.id === order.id);
                    if (idx >= 0) remainingOrders.splice(idx, 1);
                } catch (e: any) {
                    riskActions.push(`FAILED cancel BUY ${order.symbol} (daily loss guard): ${e.message}`);
                }
            }
        }

        // Hard risk guard: cash-only mode + max 10% position size.
        // If cash is negative, sell from winning positions first until cash >= 0.
        let cashNow = parseFloat(account.cash);
        const equityNow = parseFloat(account.equity);
        const maxPositionValue = equityNow * 0.10;
        let cashDeficit = cashNow < 0 ? Math.abs(cashNow) : 0;

        if (cashDeficit > 0) {
            const ranked = [...positions].sort(
                (a, b) => parseFloat(b.unrealized_pl) - parseFloat(a.unrealized_pl)
            );

            for (const p of ranked) {
                if (cashDeficit <= 0) break;

                const price = parseFloat(p.current_price || "0");
                const qtyHeld = Math.floor(parseFloat(p.qty || "0"));
                if (price <= 0 || qtyHeld <= 0) continue;

                const qtyForCash = Math.min(qtyHeld, Math.ceil(cashDeficit / price));
                if (qtyForCash <= 0) continue;

                try {
                    const openSell = remainingOrders.filter(o => o.symbol === p.symbol && o.side === "sell");
                    for (const o of openSell) {
                        await alpaca.cancelOrder(o.id);
                    }

                    const order = await alpaca.placeOrder({
                        symbol: p.symbol,
                        qty: qtyForCash,
                        side: "sell",
                        type: "market",
                        time_in_force: "day",
                    });
                    logTrade(
                        p.symbol,
                        "sell",
                        qtyForCash,
                        null,
                        "market",
                        order.id,
                        `Auto risk guard: reduce negative cash (${account.cash})`,
                        order.status
                    );
                    const released = qtyForCash * price;
                    cashDeficit = Math.max(0, cashDeficit - released);
                    riskActions.push(`SELL ${qtyForCash}x ${p.symbol} (cash guard)`);
                } catch (e: any) {
                    riskActions.push(`FAILED cash-guard sell ${p.symbol}: ${e.message}`);
                }
            }
        }

        // Trim oversized positions (>10% of equity)
        for (const p of positions) {
            const price = parseFloat(p.current_price || "0");
            const qtyHeld = Math.floor(parseFloat(p.qty || "0"));
            const marketValue = parseFloat(p.market_value || "0");
            if (price <= 0 || qtyHeld <= 0 || marketValue <= maxPositionValue) continue;

            const excessValue = marketValue - maxPositionValue;
            const trimQty = Math.min(qtyHeld, Math.ceil(excessValue / price));
            if (trimQty <= 0) continue;

            try {
                const openSell = remainingOrders.filter(o => o.symbol === p.symbol && o.side === "sell");
                for (const o of openSell) {
                    await alpaca.cancelOrder(o.id);
                }

                const order = await alpaca.placeOrder({
                    symbol: p.symbol,
                    qty: trimQty,
                    side: "sell",
                    type: "market",
                    time_in_force: "day",
                });
                logTrade(
                    p.symbol,
                    "sell",
                    trimQty,
                    null,
                    "market",
                    order.id,
                    `Auto risk guard: trim position to <=10% of equity`,
                    order.status
                );
                riskActions.push(`SELL ${trimQty}x ${p.symbol} (size guard)`);
            } catch (e: any) {
                riskActions.push(`FAILED size-guard sell ${p.symbol}: ${e.message}`);
            }
        }

        if (riskActions.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            account = await alpaca.getAccount();
            positions = await alpaca.getPositions();
        }

        let currentOpenOrders = await alpaca.getOrders("open");
        const protectionActions = await ensureDownsideProtection(positions, currentOpenOrders, "Trading cycle");
        if (protectionActions.length > 0) {
            riskActions.push(...protectionActions);
            await new Promise(resolve => setTimeout(resolve, 1000));
            account = await alpaca.getAccount();
            positions = await alpaca.getPositions();
            currentOpenOrders = await alpaca.getOrders("open");
        }
        const profitLockActions = await ensureProfitLockProtection(positions, currentOpenOrders, "Trading cycle");
        if (profitLockActions.length > 0) {
            riskActions.push(...profitLockActions);
            await new Promise(resolve => setTimeout(resolve, 1000));
            account = await alpaca.getAccount();
            positions = await alpaca.getPositions();
            currentOpenOrders = await alpaca.getOrders("open");
        }

        const positionsText = positions.length > 0
            ? positions.map(p => {
                const sector = getSector(p.symbol);
                return `${p.symbol} [${sector}]: ${p.qty} shares @ $${p.avg_entry_price} (now $${p.current_price}, P/L: $${p.unrealized_pl})`;
            }).join("\n")
            : "No open positions.";

        const ordersText = currentOpenOrders.length > 0
            ? currentOpenOrders
                .map(o => `${o.side.toUpperCase()} ${o.qty}x ${o.symbol} @ ${o.type === "limit" ? "$" + o.limit_price : (o.type === "stop" ? "$" + o.stop_price : o.type)} (Pending)`)
                .join("\n")
            : "No pending orders.";

        const lastReflectionText = lastReflection
            ? `LAST REFLECTION LESSONS:\n${lastReflection.lessons}\n\nSTRATEGY ADJUSTMENTS:\n${lastReflection.strategy_adjustments}`
            : "No previous reflection available â€” this is your first cycle.";
        const performanceSummary = getPerformanceSummary();
        const riskActionsText = riskActions.length > 0
            ? riskActions.map(a => `- ${a}`).join("\n")
            : "None";

        // Sector breakdown
        const positionSymbols = positions.map(p => p.symbol);
        const sectorCounts = countBySector(positionSymbols);
        const sectorText = Object.entries(sectorCounts)
            .map(([sector, count]) => `  ${sector}: ${count} position${count > 1 ? 's' : ''}`)
            .join("\n");

        // Cash efficiency check â€” stronger warning with mandatory action
        const equity = parseFloat(account.equity);
        const cash = parseFloat(account.cash);
        const cashPercent = (cash / equity * 100).toFixed(1);
        const investedPercent = ((equity - cash) / equity * 100).toFixed(1);
        const cashWarning = drawdownStatus.breached
            ? `\n?? CASH DEPLOYMENT OVERRIDDEN: Daily loss guard active. No new buys until next US trading day (America/New_York).`
            : (cash / equity) > 0.40
                ? `\nðŸš¨ CASH ACTION REQUIRED: ${cashPercent}% cash (${investedPercent}% invested). Target: â‰¥60% invested. YOU MUST buy more stocks this cycle!`
                : `\nâœ… Cash Utilization: ${investedPercent}% invested (target: â‰¥60%)`;

        const dailyLossGuardText = drawdownStatus.breached
            ? `ACTIVE â€” drawdown ${drawdownStatus.drawdownAmount.toFixed(2)} from start ${drawdownStatus.startEquity.toFixed(2)} (limit -${drawdownStatus.limitAmount.toFixed(2)})`
            : `inactive â€” drawdown ${drawdownStatus.drawdownAmount.toFixed(2)} from start ${drawdownStatus.startEquity.toFixed(2)} (limit -${drawdownStatus.limitAmount.toFixed(2)})`;

        // PDT status
        const pdtWarning = account.daytrade_count >= 3
            ? `\nðŸš¨ PDT WARNING: ${account.daytrade_count} day trades this week! DO NOT make any same-day buy+sell trades.`
            : `\nðŸ“Š Day Trades Used: ${account.daytrade_count}/3 this week.`;

        const handoverText = handover
            ? `SOURCE: LIGHT CYCLE (${handover.decidedAt})
REASON: ${handover.reason}
CONFIDENCE: ${handover.confidence.toFixed(2)}
CONTEXT: ${handover.context || "n/a"}`
            : "none";

        const contextMessage = `[AUTONOMOUS TRADING CYCLE â€” ${new Date().toISOString()}]

ACCOUNT STATUS:
- Equity: $${account.equity}
- Cash: $${account.cash}
- Buying Power: $${account.buying_power}
- Open Positions: ${positions.length}/7 (max 7)
- Fees: ${formatCurrentFeeTierSummary()}
- Daily loss guard: ${dailyLossGuardText}${pdtWarning}${cashWarning}

CURRENT POSITIONS:
${positionsText}

SECTOR BREAKDOWN:
${sectorText || '  No positions â€” all sectors available'}

PENDING ORDERS:
${ordersText}

AUTO RISK ACTIONS (PRE-CYCLE):
${riskActionsText}

STRATEGY PERFORMANCE (HISTORICAL):
${performanceSummary}

LIGHT HANDOVER:
${handoverText}

${lastReflectionText}

Now execute your trading workflow. Search for opportunities, research the net, decide entry prices, and make trading decisions.${drawdownStatus.breached
            ? ' DAILY LOSS GUARD IS ACTIVE: NO NEW BUYS. Perform defensive management only, run deep web news checks for open positions, and include reflection + next-day scale-in watchlist ideas in your summary.'
            : ((cash / equity) > 0.40 ? ' REMEMBER: You MUST buy more stocks because cash is too high!' : '')}`;

        // Run the agent loop with a fresh context
        const history: ChatCompletionMessageParam[] = [
            { role: "user", content: contextMessage }
        ];

        const loop = new AgentLoop(toPositiveInt(config.tradingMaxToolIterations, 24));
        const cycleToolCalls: string[] = [];
        const cycleToolResults: Array<{ name: string; result: string }> = [];
        loop.on("tool_call", ({ name, arguments: args }) => {
            cycleToolCallCount++;
            lastToolName = name;
            console.log(`  ðŸ”§ [Trading][Cycle ${cycleId}] Tool call: ${name}(${JSON.stringify(args).slice(0, 120)})`);
            cycleToolCalls.push(name);
        });
        loop.on("tool_result", ({ name, result }) => {
            cycleToolResultCount++;
            console.log(`  ?? [Trading][Cycle ${cycleId}] Tool result: ${name} -> ${summarizeLine(result, 220)}`);
            cycleToolResults.push({ name, result });
        });

        const modelResult = await loop.run(history, TRADING_SYSTEM_PROMPT, config.tradingThinking || "off");
        const hasModelSummary = Boolean(modelResult?.trim());
        let safeResult = await buildVerifiedExecutionSummary("MAIN", cycleToolResults);
        safeResult += hasModelSummary
            ? `\nModel summary was generated but is not used as execution truth.`
            : `\nModel summary missing.`;

        const agentBuyCount = cycleToolResults.filter((event) => {
            if (event.name !== "place_order") return false;
            const ok = event.result.startsWith("?") || event.result.startsWith("OK:");
            return ok && /\bBUY\b/i.test(event.result);
        }).length;

        let shouldRunAutoDeploy = false;
        if (!drawdownStatus.breached) {
            if (agentBuyCount === 0) {
                shouldRunAutoDeploy = true;
            } else {
                try {
                    const postCycleAccount = await alpaca.getAccount();
                    const postEquity = parseFloat(postCycleAccount.equity || "0");
                    const postCash = parseFloat(postCycleAccount.cash || "0");
                    const postCashRatio = postEquity > 0 ? (postCash / postEquity) : 0;
                    shouldRunAutoDeploy = postCashRatio >= config.autoDeployTopUpCashThreshold;
                } catch {
                    // If account refresh fails, keep current cycle behavior and avoid forced top-up.
                    shouldRunAutoDeploy = false;
                }
            }
        }

        if (shouldRunAutoDeploy) {
            try {
                const autoDeployActions = await runAutoDeploymentBuys(cycleToolResults);
                if (autoDeployActions.length > 0) {
                    safeResult += `\n\n?? AUTO-DEPLOY BUY FALLBACK:\n- ${autoDeployActions.join("\n- ")}`;
                }
            } catch (err: any) {
                safeResult += `\n\n?? Auto-deploy fallback failed: ${err.message}`;
            }
        } else if (drawdownStatus.breached) {
            safeResult += `\n\n?? Daily loss guard active: auto-deploy buys disabled until next US trading day (America/New_York). Defensive news-check + reflection mode enforced.`;
        }

        const alpacaMainSummary = await buildAlpacaEndStateSummary("MAIN", account, positions, currentOpenOrders);
        safeResult += `\n\n${alpacaMainSummary}`;

        // Log the cycle
        const tradingDecisionAudit = handover
            ? JSON.stringify({
                trigger: "light_handover",
                source: handover.source,
                decided_at: handover.decidedAt,
                reason: handover.reason,
                confidence: handover.confidence,
                context: handover.context,
            })
            : undefined;

        logCycle(
            "trading",
            safeResult.slice(0, 2000),
            JSON.stringify(positions),
            JSON.stringify({ equity: account.equity, cash: account.cash, buying_power: account.buying_power }),
            tradingDecisionAudit
        );

        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
        const elapsedSec = Math.round((Date.now() - cycleStartedAt) / 1000);
        console.log(`? [Trading][Cycle ${cycleId}] Cycle completed in ${elapsedSec}s.`);
        console.log(`?? [Trading][Cycle ${cycleId}] ${summarizeLine(safeResult, 320)}`);
        finalTradingResult = safeResult;
        return safeResult;

    } catch (err: any) {
        console.error("âŒ [Trading] Cycle failed:", err.message);
        lastEngineError = err.message;
        finalTradingResult = `Trading cycle error: ${err.message}`;
        return finalTradingResult;
    } finally {
        if (progressInterval) {
            clearInterval(progressInterval);
        }
        lastTradingCycleFinishedAt = new Date().toISOString();
        touchRuntimeActivity(lastTradingCycleFinishedAt);
        if (finalTradingResult) {
            lastTradingSummary = finalTradingResult.slice(0, 2000);
        }
        tradingCycleRunning = false;
        currentTradingCycleId = null;
        setTradingExecutionContext("default");
    }
}

// â”€â”€ Self-Reflection Cycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runReflectionCycle(mode: ReflectionMode = "daily"): Promise<string> {
    const isWeekly = mode === "weekly";
    console.log(isWeekly ? "ðŸ§  [Trading] Starting weekend weekly review..." : "ðŸ§  [Trading] Starting 24h self-reflection...");
    reflectionCycleRunning = true;
    lastEngineError = null;
    const startedAt = new Date().toISOString();
    touchRuntimeActivity(startedAt);
    let finalReflectionResult: string | null = null;

    try {
        const account = await alpaca.getAccount();
        const positions = await alpaca.getPositions();
        const recentTrades = getRecentTrades(isWeekly ? 200 : 50);
        const recentCycles = getRecentCycles(isWeekly ? 60 : 12);

        const now = new Date();
        const windowStart = new Date(now.getTime() - (isWeekly ? 7 : 1) * 24 * 60 * 60 * 1000);
        const recentTradesInWindow = recentTrades.filter((trade) => {
            const tradeMs = Date.parse(trade.created_at);
            return Number.isFinite(tradeMs) && tradeMs >= windowStart.getTime();
        });
        const recentCyclesInWindow = recentCycles.filter((cycle) => {
            const cycleMs = Date.parse(cycle.created_at);
            return Number.isFinite(cycleMs) && cycleMs >= windowStart.getTime();
        });

        const tradesText = recentTradesInWindow.length > 0
            ? recentTradesInWindow.map(t => `${t.created_at} | ${t.side.toUpperCase()} ${t.qty}x ${t.symbol} @ $${t.price ?? "market"} (${t.status}) â€” ${t.reasoning || "no reason"}`).join("\n")
            : `No trades in the last ${isWeekly ? "7 days" : "24 hours"}.`;

        const positionsText = positions.length > 0
            ? positions.map(p => `${p.symbol}: ${p.qty} shares, P/L: $${p.unrealized_pl} (${(parseFloat(p.unrealized_plpc) * 100).toFixed(2)}%)`).join("\n")
            : "No open positions.";

        const cycleSummaryText = recentCyclesInWindow.length > 0
            ? recentCyclesInWindow
                .slice(0, isWeekly ? 24 : 8)
                .map((cycle) => `${cycle.created_at} | ${cycle.cycle_type.toUpperCase()} | ${summarizeLine(cycle.summary, 220)}`)
                .join("\n")
            : "No recent cycle summaries.";

        const contextMessage = `[${isWeekly ? "WEEKEND WEEKLY REVIEW" : "24-HOUR SELF-REFLECTION"} â€” ${now.toISOString()}]

ACCOUNT:
- Equity: $${account.equity}
- Cash: $${account.cash}

CURRENT POSITIONS:
${positionsText}

RECENT TRADES (${isWeekly ? "last 7 days" : "last 24h"}):
${tradesText}

RECENT CYCLE SUMMARIES (${isWeekly ? "last 7 days" : "last 24h"}):
${cycleSummaryText}

Please analyze your performance and provide lessons learned and specific improvements.`;

        const history: ChatCompletionMessageParam[] = [
            { role: "user", content: contextMessage }
        ];

        const loop = new AgentLoop(toPositiveInt(config.reflectionMaxToolIterations, 8));
        const result = await loop.run(
            history,
            isWeekly ? WEEKEND_REVIEW_SYSTEM_PROMPT : REFLECTION_SYSTEM_PROMPT,
            config.tradingThinking || "off"
        );

        // Calculate rough P/L from trades
        const totalPnl = positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pl || "0"), 0);
        let combinedResult = result;
        const sections = extractReflectionSections(result);

        try {
            const selfImprove = await runSelfImproveCycle({
                reflectionText: result,
                periodStartIso: windowStart.toISOString(),
                periodEndIso: now.toISOString(),
                totalTrades: recentTradesInWindow.length,
                totalPnl,
            });

            if (selfImprove.attempted) {
                combinedResult = `${result}\n\n${selfImprove.summary}`;
                console.log(`??? [Trading] Self-improve cycle completed (${selfImprove.mode}, success=${selfImprove.success}).`);
            }
        } catch (selfImproveErr: any) {
            const selfImproveMessage = `?? Self-improve pipeline failed: ${selfImproveErr.message}`;
            combinedResult = `${result}\n\n${selfImproveMessage}`;
            console.error(`?? [Trading] ${selfImproveMessage}`);
        }

        // Log reflection
        logReflection(
            windowStart.toISOString(),
            now.toISOString(),
            recentTradesInWindow.length,
            totalPnl,
            sections.lessons.slice(0, 2000),
            sections.strategyAdjustments.slice(0, 2000)
        );

        logCycle("reflection", combinedResult.slice(0, 2000));

        console.log(isWeekly ? "âœ… [Trading] Weekend weekly review completed." : "âœ… [Trading] Self-reflection completed.");
        finalReflectionResult = combinedResult;
        return combinedResult;

    } catch (err: any) {
        console.error("âŒ [Trading] Reflection failed:", err.message);
        lastEngineError = err.message;
        finalReflectionResult = `Reflection error: ${err.message}`;
        return finalReflectionResult;
    } finally {
        reflectionCycleRunning = false;
        lastReflectionCycleAt = new Date().toISOString();
        touchRuntimeActivity(lastReflectionCycleAt);
        if (finalReflectionResult) {
            lastReflectionSummary = finalReflectionResult.slice(0, 2000);
        }
    }
}

// â”€â”€ Engine Control â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function buildLightDecisionAudit(
    decision: LightDecisionResponse,
    actionOutcome: string,
    inputTokens: number,
    outputTokens: number,
    options?: { forcedMain?: boolean; fallbackReason?: string }
): LightDecisionAudit {
    return {
        decision: decision.decision,
        reason: decision.reason,
        confidence: decision.confidence,
        handover_context: decision.handover_context,
        forced_main: Boolean(options?.forcedMain),
        fallback_reason: options?.fallbackReason,
        action_outcome: actionOutcome,
        estimated_input_tokens: inputTokens,
        max_output_tokens: outputTokens,
        model: getLightModelOverride() ?? config.model,
        timestamp: new Date().toISOString(),
    };
}

async function requestFastCycleDecision(
    mode: FastCycleMode,
    account: alpaca.AlpacaAccount,
    positions: alpaca.AlpacaPosition[],
    openOrders: alpaca.AlpacaOrder[],
    inputBudget: number,
    outputBudget: number,
    thinking: string
): Promise<{ decision: LightDecisionResponse; inputTokens: number; fallbackReason?: string }> {
    const rawDecisionContext = buildLightDecisionContext(mode, account, positions, openOrders);
    const decisionContext = trimToTokenBudget(rawDecisionContext, inputBudget);
    const decisionInputTokens = estimateTokens(LIGHT_DECISION_SYSTEM_PROMPT) + decisionContext.estimatedTokens;

    try {
        const response = await chat({
            messages: [{ role: "user", content: decisionContext.text }],
            systemPrompt: LIGHT_DECISION_SYSTEM_PROMPT,
            thinking,
            modelOverride: getLightModelOverride(),
            maxTokens: outputBudget,
        });
        const rawText = extractMessageText(response.content).trim();
        if (!rawText) {
            throw new Error("Empty response from fast-cycle model.");
        }
        return {
            decision: parseLightDecision(rawText),
            inputTokens: decisionInputTokens,
        };
    } catch (err: any) {
        return {
            decision: await buildFallbackFastDecision(mode, positions, openOrders),
            inputTokens: decisionInputTokens,
            fallbackReason: err?.message || String(err),
        };
    }
}

async function executeDeterministicFastManagement(
    mode: FastCycleMode,
    positions: alpaca.AlpacaPosition[],
    openOrders: alpaca.AlpacaOrder[]
): Promise<string[]> {
    const source = `${getFastCycleLabel(mode)} cycle`;
    const actions: string[] = [];

    actions.push(...await ensureProfitLockProtection(positions, openOrders, source));
    actions.push(...await ensureDownsideProtection(positions, openOrders, source));

    if (positions.length === 0) {
        return actions;
    }

    let barsBySymbol: Record<string, alpaca.AlpacaBar[]> = {};
    try {
        barsBySymbol = await alpaca.getBarsForSymbols(positions.map((position) => position.symbol), "1Day", 60);
    } catch (err: any) {
        actions.push(`${source}: indicator refresh failed (${err.message})`);
        return actions;
    }

    for (const position of positions) {
        const bars = barsBySymbol[position.symbol] ?? [];
        if (bars.length < 20) {
            actions.push(`${source}: ${position.symbol} skipped due to insufficient bars (${bars.length})`);
            continue;
        }

        const indicators = scoreStock(position.symbol, bars);
        const exit = checkExitCondition(indicators, toFiniteNumber(position.unrealized_plpc));
        if (!exit.shouldExit) {
            continue;
        }

        const symbolSellOrders = openOrders.filter((order) => order.symbol === position.symbol && order.side === "sell");
        for (const order of symbolSellOrders) {
            try {
                await alpaca.cancelOrder(order.id);
                actions.push(`${source}: CANCEL ${order.type} SELL ${order.qty}x ${position.symbol} before market exit`);
                const idx = openOrders.findIndex((candidate) => candidate.id === order.id);
                if (idx >= 0) openOrders.splice(idx, 1);
            } catch (err: any) {
                actions.push(`${source}: FAILED cancel ${order.type} on ${position.symbol} (${err.message})`);
            }
        }

        let refreshedPosition = position;
        try {
            refreshedPosition = await alpaca.getPosition(position.symbol);
        } catch {
            // best effort
        }

        const qtyHeld = Math.floor(toFiniteNumber(refreshedPosition.qty));
        const qtyAvailable = Math.floor(toFiniteNumber((refreshedPosition as any).qty_available ?? refreshedPosition.qty));
        const exitQty = qtyAvailable > 0 ? qtyAvailable : qtyHeld;
        if (!Number.isFinite(exitQty) || exitQty <= 0) {
            actions.push(`${source}: ${position.symbol} has no sellable quantity for market exit`);
            continue;
        }

        try {
            const order = await alpaca.placeOrder({
                symbol: position.symbol,
                qty: exitQty,
                side: "sell",
                type: "market",
                time_in_force: "day",
            });
            logTrade(
                position.symbol,
                "sell",
                exitQty,
                null,
                "market",
                order.id,
                `${source} deterministic exit: ${exit.reason}`,
                order.status
            );
            actions.push(`${source}: MARKET EXIT ${exitQty}x ${position.symbol} (${exit.reason})`);
        } catch (err: any) {
            actions.push(`${source}: FAILED market exit ${position.symbol} (${err.message})`);
        }
    }

    return actions;
}

function persistFastCycleDecision(
    mode: FastCycleMode,
    summary: string,
    audit: LightDecisionAudit,
    account?: alpaca.AlpacaAccount,
    positions?: alpaca.AlpacaPosition[]
): void {
    if (mode === "ultra_light") {
        lastUltraLightCycleAt = audit.timestamp;
        lastUltraLightDecisionAudit = { ...audit };
        lastUltraLightDecisionSummary = summary.slice(0, 1200);
    } else {
        lastLightCycleAt = audit.timestamp;
        lastLightDecisionAudit = { ...audit };
        lastLightDecisionSummary = summary.slice(0, 1200);
    }
    if (!lastEngineError && audit.action_outcome.startsWith("forced_main")) {
        lastEngineError = audit.fallback_reason || summary;
    }
    touchRuntimeActivity(audit.timestamp);
    const accountSnapshot = account
        ? JSON.stringify({
            equity: account.equity,
            cash: account.cash,
            buying_power: account.buying_power,
            daytrade_count: account.daytrade_count,
        })
        : undefined;
    const positionsSnapshot = positions
        ? JSON.stringify(
            positions.slice(0, 25).map((p) => ({
                symbol: p.symbol,
                qty: p.qty,
                pl: p.unrealized_pl,
                plpc: p.unrealized_plpc,
            }))
        )
        : undefined;

    logCycle(mode, summary.slice(0, 1200), positionsSnapshot, accountSnapshot, JSON.stringify(audit));
}

/**
 * Execute a fast cycle with one model call and deterministic broker actions.
 */
async function runFastCycle(mode: FastCycleMode): Promise<LightCycleResult> {
    const cycleLabel = getFastCycleLabel(mode);
    const engineLabel = getFastCycleEngineLabel(mode);
    const lightInputBudget = toPositiveInt(config.lightLlmMaxInputTokens, 10000);
    const lightOutputBudget = Math.min(toPositiveInt(config.lightLlmMaxOutputTokens, 800), 4096);
    const lightThinking = config.lightLlmThinking || "off";
    lastEngineError = null;

    const status = getBotActivityStatus();
    if (!status.active) {
        const summary = `${cycleLabel} decision: SKIP (bot offline).`;
        persistFastCycleDecision(
            mode,
            summary,
            buildLightDecisionAudit(
                { decision: "SKIP", reason: "Bot is outside active hours.", confidence: 1, handover_context: "" },
                "skipped_guard",
                0,
                lightOutputBudget
            )
        );
        console.log(`[Trading] ${summary}`);
        return { summary, triggerMain: false };
    }
    if (tradingCycleRunning || lightCycleAbortRequested) {
        const summary = `${cycleLabel} decision: SKIP (full cycle priority).`;
        persistFastCycleDecision(
            mode,
            summary,
            buildLightDecisionAudit(
                { decision: "SKIP", reason: "Full cycle has priority over fast cycle.", confidence: 1, handover_context: "" },
                "skipped_guard",
                0,
                lightOutputBudget
            )
        );
        console.log(`[Trading] ${summary}`);
        return { summary, triggerMain: false };
    }
    if (getRunningFlag(mode)) {
        const summary = `${cycleLabel} decision: SKIP (previous ${cycleLabel.toLowerCase()} cycle still running).`;
        persistFastCycleDecision(
            mode,
            summary,
            buildLightDecisionAudit(
                { decision: "SKIP", reason: `Previous ${cycleLabel.toLowerCase()} cycle still running.`, confidence: 1, handover_context: "" },
                "skipped_guard",
                0,
                lightOutputBudget
            )
        );
        console.log(`[Trading] ${summary}`);
        return { summary, triggerMain: false };
    }
    if (isAnotherFastCycleRunning(mode)) {
        const summary = `${cycleLabel} decision: SKIP (other fast cycle is already running).`;
        persistFastCycleDecision(
            mode,
            summary,
            buildLightDecisionAudit(
                { decision: "SKIP", reason: "Other fast cycle is already running.", confidence: 1, handover_context: "" },
                "skipped_guard",
                0,
                lightOutputBudget
            )
        );
        console.log(`[Trading] ${summary}`);
        return { summary, triggerMain: false };
    }
    if (Date.now() < fastCycleIdleUntilMs) {
        const summary = `${cycleLabel} decision: SKIP (idle cache active, no portfolio risk detected).`;
        persistFastCycleDecision(
            mode,
            summary,
            buildLightDecisionAudit(
                { decision: "SKIP", reason: "Fast-cycle idle cache active.", confidence: 1, handover_context: "" },
                "skipped_idle_cache",
                0,
                lightOutputBudget
            )
        );
        console.log(`[Trading] ${summary}`);
        return { summary, triggerMain: false };
    }

    setRunningFlag(mode, true);
    touchRuntimeActivity();
    setTradingExecutionContext(mode);

    try {
        const account = await alpaca.getAccount();
        const positions = await alpaca.getPositions();
        const openOrders = await alpaca.getOrders("open");

        if (tradingCycleRunning || lightCycleAbortRequested) {
            const summary = `${cycleLabel} decision: SKIP (preempted by full cycle).`;
            persistFastCycleDecision(
                mode,
                summary,
                buildLightDecisionAudit(
                    { decision: "SKIP", reason: `${cycleLabel} cycle preempted because full cycle started.`, confidence: 1, handover_context: "" },
                    "skipped_guard",
                    0,
                    lightOutputBudget
                ),
                account,
                positions
            );
            console.log(`[Trading] ${summary}`);
            return { summary, triggerMain: false };
        }

        if (tradingCycleRunning || lightCycleAbortRequested) {
            const summary = `${cycleLabel} decision: SKIP (preempted by full cycle).`;
            persistFastCycleDecision(
                mode,
                summary,
                buildLightDecisionAudit(
                    { decision: "SKIP", reason: `${cycleLabel} cycle preempted because full cycle started.`, confidence: 1, handover_context: "" },
                    "skipped_guard",
                    0,
                    lightOutputBudget
                ),
                account,
                positions
            );
            console.log(`[Trading] ${summary}`);
            return { summary, triggerMain: false };
        }

        const hasOpenSellRisk = openOrders.some((order) => order.side === "sell");
        if (positions.length > 0 || hasOpenSellRisk) {
            fastCycleIdleUntilMs = 0;
        }
        if (positions.length === 0 && !hasOpenSellRisk) {
            fastCycleIdleUntilMs = Date.now() + FAST_CYCLE_IDLE_CACHE_MS;
            const summary = `${cycleLabel} decision: SKIP (no open positions; fast loop idle).`;
            persistFastCycleDecision(
                mode,
                summary,
                buildLightDecisionAudit(
                    { decision: "SKIP", reason: "No open positions and no sell-side risk orders.", confidence: 1, handover_context: "" },
                    "skipped_no_positions",
                    0,
                    lightOutputBudget
                ),
                account,
                positions
            );
            console.log(`[Trading] ${summary}`);
            return { summary, triggerMain: false };
        }

        const decisionResult = await requestFastCycleDecision(
            mode,
            account,
            positions,
            openOrders,
            lightInputBudget,
            lightOutputBudget,
            lightThinking
        );
        const parsedDecision = decisionResult.decision;
        const decisionInputTokens = decisionResult.inputTokens;
        const fallbackReason = decisionResult.fallbackReason;

        if (parsedDecision.decision === "SKIP") {
            const alpacaSummary = await buildAlpacaEndStateSummary(engineLabel, account, positions, openOrders);
            const summary = `${cycleLabel} decision: SKIP - ${parsedDecision.reason}\n${alpacaSummary}`;
            persistFastCycleDecision(
                mode,
                summary,
                buildLightDecisionAudit(
                    parsedDecision,
                    "skipped_by_decision",
                    decisionInputTokens,
                    lightOutputBudget,
                    { fallbackReason }
                ),
                account,
                positions
            );
            console.log(`[Trading] ${summary}`);
            return { summary, triggerMain: false };
        }

        if (parsedDecision.decision === "MAIN") {
            const handover: TradingCycleHandover = {
                source: mode,
                reason: parsedDecision.reason,
                context: parsedDecision.handover_context,
                confidence: parsedDecision.confidence,
                decidedAt: new Date().toISOString(),
            };
            const alpacaSummary = await buildAlpacaEndStateSummary(engineLabel, account, positions, openOrders);
            const summary = `${cycleLabel} decision: MAIN - ${parsedDecision.reason}\n${alpacaSummary}`;
            persistFastCycleDecision(
                mode,
                summary,
                buildLightDecisionAudit(
                    parsedDecision,
                    "trigger_main",
                    decisionInputTokens,
                    lightOutputBudget,
                    { fallbackReason }
                ),
                account,
                positions
            );
            console.log(`[Trading] ${summary}`);
            return { summary, triggerMain: true, handover };
        }

        if (tradingCycleRunning || lightCycleAbortRequested) {
            const summary = `${cycleLabel} decision: SKIP (full cycle took over before execution).`;
            persistFastCycleDecision(
                mode,
                summary,
                buildLightDecisionAudit(
                    { decision: "SKIP", reason: "Full cycle took over before fast execution started.", confidence: 1, handover_context: "" },
                    "skipped_guard",
                    decisionInputTokens,
                    lightOutputBudget
                ),
                account,
                positions
            );
            console.log(`[Trading] ${summary}`);
            return { summary, triggerMain: false };
        }

        const actions = await executeDeterministicFastManagement(mode, positions, openOrders);
        const [refreshedAccount, refreshedPositions] = await Promise.all([
            alpaca.getAccount(),
            alpaca.getPositions(),
        ]);
        const alpacaSummary = await buildAlpacaEndStateSummary(engineLabel, account, positions, openOrders);
        const actionLine = actions.length > 0
            ? actions.join(" | ")
            : `${cycleLabel} cycle found no broker action after the model approved a fast check.`;
        const summary = `${cycleLabel} decision: LIGHT - ${parsedDecision.reason}\n${actionLine}\n${alpacaSummary}`;
        persistFastCycleDecision(
            mode,
            summary,
            buildLightDecisionAudit(
                parsedDecision,
                actions.length > 0 ? `executed_${mode}` : "executed_noop",
                decisionInputTokens,
                lightOutputBudget,
                { fallbackReason }
            ),
            refreshedAccount,
            refreshedPositions
        );
        console.log(`[Trading] ${cycleLabel} cycle completed. ${summarizeLine(summary, 260)}`);
        return { summary, triggerMain: false };
    } catch (err: any) {
        const summary = `${cycleLabel} cycle failed before decision -> MAIN escalation: ${err.message}`;
        lastEngineError = err.message;
        const handover: TradingCycleHandover = {
            source: mode,
            reason: `${cycleLabel} cycle infrastructure failure.`,
            context: err.message,
            confidence: 0,
            decidedAt: new Date().toISOString(),
        };
        persistFastCycleDecision(
            mode,
            summary,
            buildLightDecisionAudit(
                { decision: "MAIN", reason: handover.reason, confidence: 0, handover_context: handover.context },
                "forced_main_cycle_error",
                0,
                lightOutputBudget,
                { forcedMain: true, fallbackReason: err.message }
            )
        );
        console.error(`[Trading] ${cycleLabel} Cycle Error:`, err);
        return { summary, triggerMain: true, handover };
    } finally {
        setRunningFlag(mode, false);
        setTradingExecutionContext("default");
    }
}

async function runLightCycle(): Promise<LightCycleResult> {
    return runFastCycle("light");
}

async function runUltraLightCycle(): Promise<LightCycleResult> {
    return runFastCycle("ultra_light");
}

function buildEscalationHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        "content-type": "application/json",
    };
    const sharedSecret = config.escalationSharedSecret?.trim();
    if (sharedSecret) {
        headers["x-tradingclaw-webhook-secret"] = sharedSecret;
    }
    return headers;
}

async function postEscalation(target: "main" | "light", handover: TradingCycleHandover): Promise<string> {
    const url = target === "main" ? config.escalationMainUrl : config.escalationLightUrl;
    if (!url) {
        return `[Trading] Escalation ${target.toUpperCase()} skipped: no URL configured.`;
    }

    const timeoutMs = Math.max(1000, Math.floor(config.escalationRequestTimeoutMs));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: buildEscalationHeaders(),
            body: JSON.stringify(handover),
            signal: controller.signal,
        });
        const responseText = await response.text();
        if (!response.ok) {
            return `[Trading] Escalation ${target.toUpperCase()} failed: HTTP ${response.status} ${responseText.slice(0, 200)}`;
        }
        return `[Trading] Escalation ${target.toUpperCase()} accepted: ${responseText.slice(0, 200)}`;
    } catch (err: any) {
        return `[Trading] Escalation ${target.toUpperCase()} failed: ${err.message}`;
    } finally {
        clearTimeout(timer);
    }
}

async function runMainEscalation(handover: TradingCycleHandover, sourceLabel: string): Promise<string> {
    if (roleRunsMainCycles()) {
        await notifyCycleStart("TRADING CYCLE", sourceLabel);
        const fullResult = await runTradingCycle(handover);
        logScheduledResult(sourceLabel, fullResult);
        if (!fullResult.startsWith("??") && !fullResult.startsWith("?")) {
            await notifyCycleResult("TRADING CYCLE COMPLETE", fullResult);
        }
        return fullResult;
    }
    return postEscalation("main", handover);
}

/** Start the autonomous trading engine */
export async function startTradingEngine(): Promise<boolean> {
    if (!acquireEngineLock()) {
        return false;
    }
    registerEngineSignalHooks();
    lastEngineError = null;
    touchRuntimeActivity();

    console.log("â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”");
    console.log("â”‚     ðŸ“ˆ TradingClaw Trading Engine        â”‚");
    console.log("â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤");
    console.log(`â”‚  Mode:     PAPER TRADING                â”‚`);
    console.log(`â”‚  Budget:   ${config.railwayBudgetMode ? "ON " : "OFF"}                          â”‚`);
    console.log(`â”‚  Cycle:    Every ${String(config.tradingCycleHours).padEnd(2)} hours              â”‚`);
    console.log(`â”‚  Reflect:  Every ${String(config.reflectionCycleHours).padEnd(2)} hours             â”‚`);
    console.log("â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜");

    // Check connection
    const connectionStatus = await alpaca.checkConnection();
    console.log(connectionStatus);

    if (connectionStatus.startsWith("?") || connectionStatus.includes("Alpaca connection failed")) {
        console.error("â›” Cannot start trading engine â€” Alpaca connection failed.");
        releaseEngineLock();
        return false;
    }

    const tz = getEngineTimezone();

    const mainCycleEnabled = roleRunsMainCycles();
    const lightCycleEnabled = roleRunsLightCycles();
    const ultraLightCycleEnabled = roleRunsUltraLightCycles();

    // 1. Main cycle (hourly cadence by default) inside active window
    if (mainCycleEnabled) {
        tradingInterval = cron.schedule(getMainCycleCron(), async () => {
            console.log("â° [Trading] Main cycle firing...");
            await notifyCycleStart("TRADING CYCLE", "Scheduled regular cycle.");
            const result = await runTradingCycle();
            logScheduledResult("Main cycle", result);
            if (!result.startsWith("??")) {
                await notifyCycleResult("TRADING CYCLE COMPLETE", result);
            }
        }, { timezone: tz });

        // 2. Daily reflection near US close (inside session)
        reflectionInterval = cron.schedule(`55 15 * * 1-5`, async () => {
            console.log("â° [Trading] Daily reflection cycle firing...");
            await notifyCycleStart("DAILY REFLECTION", "24h review started.");
            const result = await runReflectionCycle("daily");
            logScheduledResult("Daily reflection", result);
            await notifyCycleResult("DAILY REFLECTION", result);
        }, { timezone: tz }) as any;

        // 2b. Weekend review is disabled in budget mode to avoid off-session cost.
        if (!config.railwayBudgetMode) {
            weekendReviewInterval = cron.schedule(getWeekendReviewCron(), async () => {
                console.log("â° [Trading] Weekend weekly review firing...");
                await notifyCycleStart("WEEKEND WEEKLY REVIEW", "Weekend strategy review started.");
                const result = await runReflectionCycle("weekly");
                logScheduledResult("Weekend weekly review", result);
                await notifyCycleResult("WEEKEND WEEKLY REVIEW", result);
            }, { timezone: tz }) as any;
        }
    }

    // 3. Ultra-light cycle during US regular trading hours
    if (ultraLightCycleEnabled) {
        ultraLightInterval = cron.schedule(getUltraLightCycleCron(), async () => {
            const ultraResult = await runUltraLightCycle();
            await notifyFastCycleResult("ultra_light", ultraResult.summary);
            if (ultraResult.triggerMain && ultraResult.handover) {
                console.log("[Trading] Ultra-light decision escalated.");
                if (config.runtimeRole === "ultra" && config.escalationLightUrl) {
                    const escalation = await postEscalation("light", ultraResult.handover);
                    logScheduledResult("Ultra-light -> light escalation", escalation);
                    if (escalation.includes("failed")) {
                        const fallback = await runMainEscalation(ultraResult.handover, `Escalated from ultra-light (fallback): ${ultraResult.handover.reason}`);
                        if (fallback.startsWith("[Trading] Escalation")) {
                            logScheduledResult("Ultra-light -> main escalation", fallback);
                        }
                    }
                    return;
                }

                const result = await runMainEscalation(ultraResult.handover, `Escalated from ultra-light: ${ultraResult.handover.reason}`);
                if (result.startsWith("[Trading] Escalation")) {
                    logScheduledResult("Ultra-light -> main escalation", result);
                }
            }
        }, { timezone: tz }) as any;
    }

    // 4. Light cycle during US regular trading hours
    if (lightCycleEnabled) {
        lightInterval = cron.schedule(getLightCycleCron(), async () => {
            const lightResult = await runLightCycle();
            await notifyFastCycleResult("light", lightResult.summary);
            if (lightResult.triggerMain && lightResult.handover) {
                console.log("?? [Trading] Light decision escalated.");
                const result = await runMainEscalation(lightResult.handover, `Escalated from light cycle: ${lightResult.handover.reason}`);
                if (result.startsWith("[Trading] Escalation")) {
                    logScheduledResult("Light -> main escalation", result);
                }
            }
        }, { timezone: tz }) as any;
    }

    console.log(`ðŸ“ˆ [Trading] Engine started with cost-optimized schedules [${tz}].`);
    console.log(`   - Active window: Mon-Fri 09:30-16:00 (${tz})`);
    console.log(`   - Runtime Role: ${config.runtimeRole}`);
    console.log(`   - Main Cycle: ${mainCycleEnabled ? `every ${toPositiveInt(config.tradingCycleHours, 1)} hour(s)` : "disabled"}`);
    if (!mainCycleEnabled) {
        console.log(`   - Weekend Review: disabled (runtime role)`);
    } else if (config.railwayBudgetMode) {
        console.log(`   - Weekend Review: disabled in budget mode`);
    } else {
        console.log(`   - Weekend Review: Saturday + Sunday 12:05 (${tz})`);
    }
    if (lightCycleEnabled) {
        console.log(`   - Light Cycle: every ${toPositiveInt(config.lightCycleIntervalMinutes, 1)} minute(s)`);
    } else {
        console.log(`   - Light Cycle: disabled`);
    }
    if (ultraLightCycleEnabled) {
        console.log(`   - Ultra-Light Cycle: every ${toPositiveInt(config.ultraLightCycleIntervalMinutes, 1)} minute(s)`);
    } else {
        console.log(`   - Ultra-Light Cycle: disabled`);
    }
    return true;
}

/** Stop the trading engine */
export function stopTradingEngine(): void {
    if (tradingInterval) tradingInterval.stop();
    if (reflectionInterval) (reflectionInterval as any).stop();
    if (weekendReviewInterval) (weekendReviewInterval as any).stop();
    if (lightInterval) (lightInterval as any).stop();
    if (ultraLightInterval) (ultraLightInterval as any).stop();
    tradingInterval = null;
    reflectionInterval = null;
    weekendReviewInterval = null;
    lightInterval = null;
    ultraLightInterval = null;
    tradingCycleRunning = false;
    lightCycleRunning = false;
    ultraLightCycleRunning = false;
    reflectionCycleRunning = false;
    lightCycleAbortRequested = false;
    fastCycleIdleUntilMs = 0;
    currentTradingCycleId = null;
    touchRuntimeActivity();
    setTradingExecutionContext("default");
    releaseEngineLock();
    console.log("?? [Trading] Engine stopped.");
}

/** Manually trigger a trading cycle (e.g. from Telegram command) */
export async function manualTradingCycle(handover?: {
    source?: "light" | "ultra_light";
    reason?: string;
    context?: string;
    confidence?: number;
}): Promise<string> {
    if (!handover) {
        return runTradingCycle();
    }
    const normalized: TradingCycleHandover = {
        source: handover.source === "ultra_light" ? "ultra_light" : "light",
        reason: handover.reason?.trim() || "Escalated cycle request",
        context: handover.context?.trim() || "",
        confidence: Number.isFinite(handover.confidence) ? Number(handover.confidence) : 0.5,
        decidedAt: new Date().toISOString(),
    };
    return runTradingCycle(normalized);
}

/** Manually trigger a reflection cycle */
export async function manualReflectionCycle(): Promise<string> {
    return runReflectionCycle();
}

/** Manually trigger a light cycle (for ultra->light escalation services) */
export async function manualLightCycle(): Promise<{ summary: string; triggerMain: boolean; handover?: { source: "light" | "ultra_light"; reason: string; context: string; confidence: number; decidedAt: string } }> {
    return runLightCycle();
}

/** Get a quick status summary */
export async function getTradingStatus(): Promise<string> {
    try {
        const account = await alpaca.getAccount();
        const positions = await alpaca.getPositions();
        const recentTrades = getRecentTrades(5);

        const posText = positions.length > 0
            ? positions.map(p => {
                const pl = parseFloat(p.unrealized_pl);
                const icon = pl >= 0 ? "ðŸ“ˆ" : "ðŸ“‰";
                return `${icon} ${p.symbol}: ${p.qty} shares ($${p.unrealized_pl})`;
            }).join("\n")
            : "No open positions.";

        const tradesText = recentTrades.length > 0
            ? recentTrades.slice(0, 3).map(t => `â€¢ ${t.side.toUpperCase()} ${t.qty}x ${t.symbol} â€” ${t.status}`).join("\n")
            : "No recent trades.";

        return [
            `ðŸ’° **Account**`,
            `Equity: $${account.equity} | Cash: $${account.cash}`,
            `Buying Power: $${account.buying_power}`,
            ``,
            `ðŸ“Š **Positions**`,
            posText,
            ``,
            `ðŸ“ **Recent Trades**`,
            tradesText,
        ].join("\n");
    } catch (err: any) {
        return `Error getting status: ${err.message}`;
    }
}

