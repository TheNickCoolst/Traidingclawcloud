import fs from "fs";
import path from "path";
import * as alpaca from "../trading/alpaca.js";
import { getLatestReflection, getLatestWeeklyReflection, getRecentCycles, getRecentTrades, type CycleLogEntry, type TradeLogEntry, type ReflectionEntry } from "../trading/journal.js";
import { evaluateDailyDrawdown, type DailyDrawdownStatus } from "../trading/risk-controls.js";
import { getTradingRuntimeSnapshot, type TradingRuntimeSnapshot } from "../trading/engine.js";
import { getTokenUsageStats, type TokenUsageStats } from "../db.js";

export type DashboardCycleType = "all" | "trading" | "light" | "ultra_light" | "reflection";

export interface DashboardCycleEntry {
    id: number;
    cycleType: string;
    summary: string;
    createdAt: string;
    positionsSnapshot: unknown;
    accountSnapshot: unknown;
    decisionAudit: unknown;
}

export interface DashboardLogsResponse {
    todayLogPath: string | null;
    todayLogLines: string[];
    cycleLogPath: string | null;
    cycleLogLines: string[];
}

export interface DashboardOverviewResponse {
    generatedAt: string;
    runtime: TradingRuntimeSnapshot;
    tokenUsage: TokenUsageStats;
    latestReflection: ReflectionEntry | null;
    latestWeeklyReflection: ReflectionEntry | null;
    dailyRiskStatus: DailyDrawdownStatus | null;
    account: alpaca.AlpacaAccount | null;
    positions: alpaca.AlpacaPosition[];
    openOrders: alpaca.AlpacaOrder[];
    recentHighlights: {
        trading: DashboardCycleEntry | null;
        light: DashboardCycleEntry | null;
        ultraLight: DashboardCycleEntry | null;
        reflection: DashboardCycleEntry | null;
    };
    liveDataError: string | null;
}

function maybeRepairMojibake(value: string): string {
    if (!/[Ãâð]/.test(value)) return value;
    try {
        const repaired = Buffer.from(value, "latin1").toString("utf8");
        const replacementCount = (repaired.match(/\uFFFD/g) || []).length;
        if (replacementCount > 0) return value;
        return repaired;
    } catch {
        return value;
    }
}

function normalizeText(value: string | null | undefined): string | null {
    if (value == null) return null;
    return maybeRepairMojibake(value);
}

function normalizeReflection(entry: ReflectionEntry | undefined): ReflectionEntry | null {
    if (!entry) return null;
    return {
        ...entry,
        lessons: normalizeText(entry.lessons),
        strategy_adjustments: normalizeText(entry.strategy_adjustments),
    };
}

function tryParseJson(value: string | null): unknown {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function normalizeCycle(entry: CycleLogEntry): DashboardCycleEntry {
    return {
        id: entry.id,
        cycleType: entry.cycle_type,
        summary: normalizeText(entry.summary) || entry.summary,
        createdAt: entry.created_at,
        positionsSnapshot: tryParseJson(entry.positions_snapshot),
        accountSnapshot: tryParseJson(entry.account_snapshot),
        decisionAudit: tryParseJson(entry.decisions),
    };
}

function getLatestCycleOfType(type: Exclude<DashboardCycleType, "all">): DashboardCycleEntry | null {
    const latest = getRecentCycles(1, type)[0];
    return latest ? normalizeCycle(latest) : null;
}

function readLastLines(filePath: string, lines: number): string[] {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .slice(-Math.max(1, lines));
}

function getTodayLogPath(): string {
    const now = new Date();
    const filename = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.log`;
    return path.join(process.cwd(), "logs", filename);
}

export async function getDashboardOverview(): Promise<DashboardOverviewResponse> {
    const runtime = getTradingRuntimeSnapshot();
    const tokenUsage = getTokenUsageStats();
    const latestReflection = normalizeReflection(getLatestReflection());
    const latestWeeklyReflection = normalizeReflection(getLatestWeeklyReflection());
    const recentHighlights = {
        trading: getLatestCycleOfType("trading"),
        light: getLatestCycleOfType("light"),
        ultraLight: getLatestCycleOfType("ultra_light"),
        reflection: getLatestCycleOfType("reflection"),
    };

    let account: alpaca.AlpacaAccount | null = null;
    let positions: alpaca.AlpacaPosition[] = [];
    let openOrders: alpaca.AlpacaOrder[] = [];
    let dailyRiskStatus: DailyDrawdownStatus | null = null;
    let liveDataError: string | null = null;

    try {
        [account, positions, openOrders] = await Promise.all([
            alpaca.getAccount(),
            alpaca.getPositions(),
            alpaca.getOrders("open"),
        ]);
        dailyRiskStatus = evaluateDailyDrawdown(Number(account.equity));
    } catch (err: any) {
        liveDataError = err?.message || String(err);
    }

    return {
        generatedAt: new Date().toISOString(),
        runtime,
        tokenUsage,
        latestReflection,
        latestWeeklyReflection,
        dailyRiskStatus,
        account,
        positions,
        openOrders,
        recentHighlights,
        liveDataError,
    };
}

export function getDashboardCycles(limit: number = 20, type: DashboardCycleType = "all"): DashboardCycleEntry[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit) || 20));
    const entries = type === "all"
        ? getRecentCycles(safeLimit)
        : getRecentCycles(safeLimit, type);

    return entries.map(normalizeCycle);
}

export function getDashboardTrades(limit: number = 20): TradeLogEntry[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit) || 20));
    return getRecentTrades(safeLimit).map((trade) => ({
        ...trade,
        reasoning: normalizeText(trade.reasoning),
    }));
}

export function getDashboardLogs(lines: number = 120): DashboardLogsResponse {
    const safeLines = Math.max(20, Math.min(400, Math.floor(lines) || 120));
    const todayLogPath = getTodayLogPath();
    const cycleLogPath = path.join(process.cwd(), "data", "logs", "cycles.log");

    return {
        todayLogPath: fs.existsSync(todayLogPath) ? todayLogPath : null,
        todayLogLines: readLastLines(todayLogPath, safeLines).map((line) => normalizeText(line) || line),
        cycleLogPath: fs.existsSync(cycleLogPath) ? cycleLogPath : null,
        cycleLogLines: readLastLines(cycleLogPath, safeLines).map((line) => normalizeText(line) || line),
    };
}
