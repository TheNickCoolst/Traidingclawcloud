/**
 * Trade Journal — SQLite persistence for trade logs, cycle summaries, and reflections.
 * Also writes detailed flat-files to data/logs/ for human review.
 */
import { db } from "../db.js";
import fs from "fs";
import path from "path";
import { notifyTradeEvent } from "./telegram-reporter.js";

// ── File Logging Setup ───────────────────────────────────────────────────────

const LOGS_DIR = path.join(process.cwd(), "data", "logs");
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

export function appendToLog(filename: string, content: string) {
  const timestamp = new Date().toISOString();
  const formatted = `\n\n========== [${timestamp}] ==========\n${content}`;
  fs.appendFileSync(path.join(LOGS_DIR, filename), formatted, "utf-8");
}

// ── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS trade_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,          -- 'buy' or 'sell'
    qty REAL NOT NULL,
    price REAL,                  -- filled price (null if not filled yet)
    order_type TEXT NOT NULL,    -- 'market' or 'limit'
    order_id TEXT,               -- Alpaca order ID
    reasoning TEXT,              -- LLM's reasoning for the trade
    status TEXT DEFAULT 'submitted',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cycle_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_type TEXT NOT NULL,    -- 'trading', 'reflection', or 'light'
    summary TEXT NOT NULL,       -- What happened in this cycle
    positions_snapshot TEXT,     -- JSON snapshot of positions at cycle time
    account_snapshot TEXT,       -- JSON snapshot of account at cycle time
    decisions TEXT,              -- JSON array of decisions made
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reflection_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_start DATETIME,
    period_end DATETIME,
    total_trades INTEGER DEFAULT 0,
    total_pnl REAL DEFAULT 0,
    lessons TEXT,                -- What the bot learned
    strategy_adjustments TEXT,   -- Changes to strategy
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS performance_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    strategy_tag TEXT NOT NULL,  -- e.g. 'multi_factor_score_3', 'score_5', etc.
    entry_price REAL,
    exit_price REAL,
    pnl REAL DEFAULT 0,
    won INTEGER DEFAULT 0,      -- 1 = win, 0 = loss
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Prepared Statements ──────────────────────────────────────────────────────

const stmts = {
  logTrade: db.prepare(`
    INSERT INTO trade_log (symbol, side, qty, price, order_type, order_id, reasoning, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  logCycle: db.prepare(`
    INSERT INTO cycle_log (cycle_type, summary, positions_snapshot, account_snapshot, decisions)
    VALUES (?, ?, ?, ?, ?)
  `),
  logReflection: db.prepare(`
    INSERT INTO reflection_log (period_start, period_end, total_trades, total_pnl, lessons, strategy_adjustments)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getRecentTrades: db.prepare(`
    SELECT * FROM trade_log ORDER BY created_at DESC LIMIT ?
  `),
  getTradesSince: db.prepare(`
    SELECT * FROM trade_log WHERE created_at >= ? ORDER BY created_at DESC
  `),
  getRecentCycles: db.prepare(`
    SELECT * FROM cycle_log ORDER BY created_at DESC LIMIT ?
  `),
  getRecentCyclesByType: db.prepare(`
    SELECT * FROM cycle_log WHERE cycle_type = ? ORDER BY created_at DESC LIMIT ?
  `),
  getLatestReflection: db.prepare(`
    SELECT * FROM reflection_log ORDER BY created_at DESC LIMIT 1
  `),
  getLatestWeeklyReflection: db.prepare(`
    SELECT *
    FROM reflection_log
    WHERE period_start IS NOT NULL
      AND period_end IS NOT NULL
      AND (julianday(period_end) - julianday(period_start)) >= 6
    ORDER BY created_at DESC
    LIMIT 1
  `),
  getRecentReflections: db.prepare(`
    SELECT * FROM reflection_log ORDER BY created_at DESC LIMIT ?
  `),
  logPerformance: db.prepare(`
    INSERT INTO performance_stats (symbol, strategy_tag, entry_price, exit_price, pnl, won)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getWinRate: db.prepare(`
    SELECT strategy_tag,
           COUNT(*) as total,
           SUM(won) as wins,
           AVG(pnl) as avg_pnl
    FROM performance_stats
    WHERE strategy_tag = ?
    GROUP BY strategy_tag
  `),
  getAllWinRates: db.prepare(`
    SELECT strategy_tag,
           COUNT(*) as total,
           SUM(won) as wins,
           ROUND(CAST(SUM(won) AS FLOAT) / COUNT(*) * 100, 1) as win_rate_pct,
           ROUND(AVG(pnl), 2) as avg_pnl
    FROM performance_stats
    GROUP BY strategy_tag
    ORDER BY win_rate_pct DESC
  `),
};

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface TradeLogEntry {
  id: number;
  symbol: string;
  side: string;
  qty: number;
  price: number | null;
  order_type: string;
  order_id: string | null;
  reasoning: string | null;
  status: string;
  created_at: string;
}

export interface CycleLogEntry {
  id: number;
  cycle_type: string;
  summary: string;
  positions_snapshot: string | null;
  account_snapshot: string | null;
  decisions: string | null;
  created_at: string;
}

export interface ReflectionEntry {
  id: number;
  period_start: string | null;
  period_end: string | null;
  total_trades: number;
  total_pnl: number;
  lessons: string | null;
  strategy_adjustments: string | null;
  created_at: string;
}

// ── Functions ────────────────────────────────────────────────────────────────

/** Log a trade execution */
export function logTrade(
  symbol: string,
  side: string,
  qty: number,
  price: number | null,
  orderType: string,
  orderId: string | null,
  reasoning: string | null,
  status: string = "submitted"
): number {
  const result = stmts.logTrade.run(symbol, side, qty, price, orderType, orderId, reasoning, status);

  // Write to flat file log
  const logStr = `TRADE: ${side.toUpperCase()} ${qty}x ${symbol} @ ${price ?? "MARKET"}\nType: ${orderType}, Status: ${status}, ID: ${orderId}\nReasoning:\n${reasoning}`;
  appendToLog("trades.log", logStr);

  void notifyTradeEvent({
    symbol,
    side,
    qty,
    price,
    orderType,
    orderId,
    status,
    reasoning,
  });

  return result.lastInsertRowid as number;
}

/** Log a trading or reflection cycle summary */
export function logCycle(
  cycleType: "trading" | "reflection" | "light" | "ultra_light",
  summary: string,
  positionsSnapshot?: string,
  accountSnapshot?: string,
  decisions?: string
): number {
  const result = stmts.logCycle.run(cycleType, summary, positionsSnapshot || null, accountSnapshot || null, decisions || null);

  // Write to flat file log
  const logStr = `TYPE: ${cycleType.toUpperCase()}\n${summary}\n\nPositions Snapshot:\n${positionsSnapshot || "None"}\n\nAccount Snapshot:\n${accountSnapshot || "None"}`;
  appendToLog("cycles.log", logStr);

  return result.lastInsertRowid as number;
}

/** Log a self-reflection */
export function logReflection(
  periodStart: string,
  periodEnd: string,
  totalTrades: number,
  totalPnl: number,
  lessons: string,
  strategyAdjustments: string
): number {
  const result = stmts.logReflection.run(periodStart, periodEnd, totalTrades, totalPnl, lessons, strategyAdjustments);
  return result.lastInsertRowid as number;
}

/** Get recent trades */
export function getRecentTrades(limit: number = 20): TradeLogEntry[] {
  return stmts.getRecentTrades.all(limit) as TradeLogEntry[];
}

/** Get trades since a specific datetime */
export function getTradesSince(since: string): TradeLogEntry[] {
  return stmts.getTradesSince.all(since) as TradeLogEntry[];
}

/** Get recent cycle logs */
export function getRecentCycles(limit: number = 10, cycleType?: "trading" | "reflection" | "light" | "ultra_light"): CycleLogEntry[] {
  if (cycleType) {
    return stmts.getRecentCyclesByType.all(cycleType, limit) as CycleLogEntry[];
  }
  return stmts.getRecentCycles.all(limit) as CycleLogEntry[];
}

/** Get the most recent self-reflection */
export function getLatestReflection(): ReflectionEntry | undefined {
  return stmts.getLatestReflection.get() as ReflectionEntry | undefined;
}

/** Get the most recent weekly reflection/review */
export function getLatestWeeklyReflection(): ReflectionEntry | undefined {
  return stmts.getLatestWeeklyReflection.get() as ReflectionEntry | undefined;
}

/** Get recent reflections */
export function getRecentReflections(limit: number = 10): ReflectionEntry[] {
  return stmts.getRecentReflections.all(limit) as ReflectionEntry[];
}

/** Build a short summary of open trades for context injection */
export function getOpenTradesSummary(): string {
  const recent = getRecentTrades(50);
  const buys = recent.filter(t => t.side === "buy" && t.status !== "cancelled");
  if (buys.length === 0) return "No recent trades logged.";

  return buys
    .slice(0, 10)
    .map(t => `${t.side.toUpperCase()} ${t.qty}x ${t.symbol} @ $${t.price ?? "market"} (${t.status}) — ${t.reasoning?.slice(0, 60) || "no reason"}`)
    .join("\n");
}

/** Log a completed trade's performance for strategy weighting */
export function logPerformance(
  symbol: string,
  strategyTag: string,
  entryPrice: number,
  exitPrice: number,
  pnl: number
): void {
  const won = pnl > 0 ? 1 : 0;
  stmts.logPerformance.run(symbol, strategyTag, entryPrice, exitPrice, pnl, won);
}

/** Get win-rate for a specific strategy tag */
export function getStrategyWinRate(strategyTag: string): { total: number; wins: number; winRate: number; avgPnl: number } {
  const row = stmts.getWinRate.get(strategyTag) as any;
  if (!row) return { total: 0, wins: 0, winRate: 0.5, avgPnl: 0 };
  return {
    total: row.total,
    wins: row.wins,
    winRate: row.total > 0 ? row.wins / row.total : 0.5,
    avgPnl: row.avg_pnl || 0,
  };
}

/** Get summary of all strategy performance for LLM context */
export function getPerformanceSummary(): string {
  const rows = stmts.getAllWinRates.all() as any[];
  if (rows.length === 0) return "No performance data yet — too early to optimize.";
  return rows.map(r =>
    `  ${r.strategy_tag}: ${r.wins}/${r.total} wins (${r.win_rate_pct}%), avg P/L: $${r.avg_pnl}`
  ).join("\n");
}
