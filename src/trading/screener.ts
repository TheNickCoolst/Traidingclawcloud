/**
 * Watchlist Screener — scans a curated list of liquid US stocks,
 * computes RSI + EMA indicators for each, and returns sorted results.
 *
 * BUY candidates are sorted by RSI ascending (most oversold first).
 * Used by the `screen_watchlist` tool available to the LLM.
 */
import * as alpaca from "./alpaca.js";
import { scoreStock, type IndicatorResult } from "./strategy.js";
import { appendToLog } from "./journal.js";
import { getSector } from "./sectors.js";
import { config } from "../config.js";

import { WATCHLIST as SP500_WATCHLIST } from "./sp500.js";

// Keep symbols exactly as provided by the dataset (e.g. BRK.B, BF.B).
export const WATCHLIST = SP500_WATCHLIST.map(sym => sym.trim()).filter(Boolean);

// ── Screener ──────────────────────────────────────────────────────────────────

export interface ScreenResult {
    results: IndicatorResult[];
    buySignals: IndicatorResult[];
    sellSignals: IndicatorResult[];
    timestamp: string;
    screened: number;
    attempted: number;
    staleFiltered: number;
    timedOut: boolean;
    durationMs: number;
    errors: string[];
}

function getScreenerBatchSize(): number {
    const size = Math.floor(config.screenerBatchSize);
    if (!Number.isFinite(size)) return 80;
    return Math.min(120, Math.max(20, size));
}

function getScreenerMaxRuntimeMs(): number {
    const runtime = Math.floor(config.screenerMaxRuntimeMs);
    if (!Number.isFinite(runtime)) return 90000;
    return Math.min(300000, Math.max(20000, runtime));
}

function getMaxBarAgeHours(): number {
    const hours = Math.floor(config.maxBarStalenessHours);
    if (!Number.isFinite(hours)) return 120;
    return Math.min(336, Math.max(24, hours));
}

function getLastBarAgeHours(bars: alpaca.AlpacaBar[]): number {
    const lastTs = bars.at(-1)?.t;
    if (!lastTs) return Number.POSITIVE_INFINITY;
    const lastMs = Date.parse(lastTs);
    if (!Number.isFinite(lastMs)) return Number.POSITIVE_INFINITY;
    const ageMs = Math.max(0, Date.now() - lastMs);
    return ageMs / (1000 * 60 * 60);
}

/**
 * Run the full watchlist screen.
 * Fetches 60 days of daily bars per symbol and computes indicators.
 * Returns sorted results: BUY candidates first (by RSI asc), then HOLD, then SELL.
 */
export async function runWatchlistScreen(): Promise<ScreenResult> {
    const results: IndicatorResult[] = [];
    const errors: string[] = [];
    const startedAt = Date.now();
    const batchSize = getScreenerBatchSize();
    const maxRuntimeMs = getScreenerMaxRuntimeMs();
    const maxBarAgeHours = getMaxBarAgeHours();
    let attempted = 0;
    let staleFiltered = 0;
    let timedOut = false;

    // Batch fetch to avoid multi-minute screener stalls while still using fresh market data.
    for (let i = 0; i < WATCHLIST.length; i += batchSize) {
        if ((Date.now() - startedAt) >= maxRuntimeMs) {
            timedOut = true;
            errors.push(`Screener runtime limit hit (${maxRuntimeMs}ms). Returning partial fresh results.`);
            break;
        }

        const batch = WATCHLIST.slice(i, i + batchSize);
        attempted += batch.length;
        let barsBySymbol: Record<string, alpaca.AlpacaBar[]> = {};
        try {
            barsBySymbol = await alpaca.getBarsForSymbols(batch, "1Day", 60);
        } catch (err: any) {
            errors.push(`Batch ${batch[0]}..${batch.at(-1)} failed: ${err.message}. Falling back to single-symbol fetch.`);
            for (const symbol of batch) {
                if ((Date.now() - startedAt) >= maxRuntimeMs) {
                    timedOut = true;
                    errors.push(`Screener runtime limit hit during fallback (${maxRuntimeMs}ms). Returning partial fresh results.`);
                    break;
                }
                try {
                    barsBySymbol[symbol] = await alpaca.getBars(symbol, "1Day", 60);
                } catch (singleErr: any) {
                    errors.push(`${symbol}: ${singleErr.message}`);
                    barsBySymbol[symbol] = [];
                }
            }
            if (timedOut) break;
        }

        for (const symbol of batch) {
            const bars = barsBySymbol[symbol] ?? [];
            if (bars.length < 20) {
                errors.push(`${symbol}: only ${bars.length} bars returned (need 20+)`);
                continue;
            }

            const ageHours = getLastBarAgeHours(bars);
            if (!Number.isFinite(ageHours) || ageHours > maxBarAgeHours) {
                staleFiltered++;
                errors.push(`${symbol}: stale bars (${ageHours.toFixed(1)}h old, max ${maxBarAgeHours}h)`);
                continue;
            }

            try {
                const result = scoreStock(symbol, bars);
                results.push(result);
            } catch (err: any) {
                errors.push(`${symbol}: indicator score failed (${err.message})`);
            }
        }
    }

    const buySignals = results
        .filter(r => r.signal === "BUY")
        .sort((a, b) => b.score - a.score || a.rsi14 - b.rsi14); // highest score first, then most oversold

    const sellSignals = results.filter(r =>
        r.signal === "SELL_OVERBOUGHT" || r.signal === "SELL_TREND_BREAK"
    );

    // Sort overall: BUY first, then SELL, then HOLD
    const sorted = [
        ...buySignals,
        ...sellSignals,
        ...results.filter(r => r.signal === "HOLD"),
    ];

    const screenObj: ScreenResult = {
        results: sorted,
        buySignals,
        sellSignals,
        timestamp: new Date().toISOString(),
        screened: results.length,
        attempted,
        staleFiltered,
        timedOut,
        durationMs: Date.now() - startedAt,
        errors,
    };

    // Auto-log to flat file
    appendToLog("screener.log", formatScreenResult(screenObj));

    return screenObj;
}

/**
 * Format a screen result as a human-readable text block for the LLM.
 */
export function formatScreenResult(screen: ScreenResult): string {
    const lines: string[] = [
        `📡 Watchlist Screen — ${screen.timestamp}`,
        `Screened: ${screen.screened}/${WATCHLIST.length} stocks (attempted ${screen.attempted}, stale filtered ${screen.staleFiltered}, runtime ${(screen.durationMs / 1000).toFixed(1)}s${screen.timedOut ? ", partial timeout" : ""})`,
        ``,
    ];

    if (screen.buySignals.length > 0) {
        lines.push(`🟢 BUY SIGNALS (${screen.buySignals.length}):`);
        for (const r of screen.buySignals) {
            const sector = getSector(r.symbol);
            lines.push(
                `  ${r.symbol} [${sector}]: $${r.currentPrice.toFixed(2)} | Score: ${r.score}/6 | RSI: ${r.rsi14.toFixed(1)} | MACD Hist: ${r.macdHist.toFixed(3)} | ATR: $${r.atr14.toFixed(2)} | Vol: ${r.volumeRatio.toFixed(2)}×`,
                `    → ${r.reason}`
            );
        }
        lines.push(``);
    } else {
        lines.push(`🟢 BUY SIGNALS: None this cycle`);
        lines.push(``);
    }

    if (screen.sellSignals.length > 0) {
        lines.push(`🔴 SELL SIGNALS (${screen.sellSignals.length}):`);
        for (const r of screen.sellSignals) {
            lines.push(`  ${r.symbol}: $${r.currentPrice.toFixed(2)} | RSI: ${r.rsi14.toFixed(1)} → ${r.reason}`);
        }
        lines.push(``);
    }

    lines.push(`⚪ HOLD (${screen.results.length - screen.buySignals.length - screen.sellSignals.length} stocks not listed above):`);
    // Omitting individual HOLD stock lines to prevent LLM context window bloat

    if (screen.errors.length > 0) {
        lines.push(``, `⚠️ Errors:`, ...screen.errors.map((e: string) => `  ${e}`));
    }

    return lines.join("\n");
}
