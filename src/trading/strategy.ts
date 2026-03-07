/**
 * Strategy Engine — Multi-Factor Scoring System
 *
 * Pure math module. No API calls, no LLM dependencies.
 * Computes technical indicators from OHLCV bar data.
 *
 * ENTRY: Multi-factor score (0-6): RSI + EMA Crossover + Volume Surge + MACD Crossover
 *        BUY when score >= 3
 * EXIT:  RSI > 70 OR ATR-based dynamic stop-loss OR +10% take-profit (or Trailing Stop)
 */
import type { AlpacaBar } from "./alpaca.js";

// ── Signal Types ──────────────────────────────────────────────────────────────

export type Signal = "BUY" | "SELL_OVERBOUGHT" | "SELL_TREND_BREAK" | "HOLD";

export interface IndicatorResult {
    symbol: string;
    currentPrice: number;
    rsi14: number;
    ema50: number;
    ema200: number;                // EMA(200) for trend detection
    macd: number;                  // MACD Line
    macdSignal: number;            // Signal Line
    macdHist: number;              // MACD Histogram
    atr14: number;                 // Average True Range (14 period)
    avgVolume20: number;
    currentVolume: number;
    volumeRatio: number;           // currentVolume / avgVolume20
    volumeSurge: boolean;          // currentVolume > 1.5× avgVolume20
    macdCrossover: boolean;        // MACD line > Signal line
    emaCrossover: boolean;         // EMA50 > EMA200 (uptrend)
    priceAboveEma: boolean;
    score: number;                 // Multi-factor score (0-6)
    signal: Signal;
    reason: string;
    canBuy: boolean;               // true only when score >= 3
}

export interface BuySetupVerdict {
    valid: boolean;
    reason: string;
}

// ── Math Helpers ──────────────────────────────────────────────────────────────

/**
 * Compute Exponential Moving Average (EMA) for a given period.
 * Uses first `period` bars as baseline SMA, then applies EMA smoothing.
 */
function computeEMA(closes: number[], period: number): number {
    if (closes.length < period) {
        // Not enough data — fall back to simple average
        return closes.reduce((a, b) => a + b, 0) / closes.length;
    }

    // Seed with SMA of first `period` values
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const multiplier = 2 / (period + 1);

    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] - ema) * multiplier + ema;
    }

    return ema;
}

/**
 * Compute 14-period RSI using Wilder's Smoothed Average (the original formula).
 * Returns a value between 0 and 100.
 */
function computeRSI(closes: number[], period: number = 14): number {
    if (closes.length < period + 1) return 50; // neutral if not enough data

    // Compute initial gains/losses
    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 1; i <= period; i++) {
        const delta = closes[i] - closes[i - 1];
        if (delta > 0) avgGain += delta;
        else avgLoss += Math.abs(delta);
    }

    avgGain /= period;
    avgLoss /= period;

    // Apply Wilder's smoothing for remaining bars
    for (let i = period + 1; i < closes.length; i++) {
        const delta = closes[i] - closes[i - 1];
        const gain = delta > 0 ? delta : 0;
        const loss = delta < 0 ? Math.abs(delta) : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

/**
 * Compute simple average volume over last N bars.
 */
function computeAvgVolume(volumes: number[], period: number = 20): number {
    const slice = volumes.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * Compute MACD (Moving Average Convergence Divergence)
 * Standard periods: 12 (fast), 26 (slow), 9 (signal)
 */
function computeMACD(closes: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (closes.length < slowPeriod + signalPeriod) {
        return { macd: 0, signal: 0, hist: 0 };
    }

    const emaFastPath: number[] = [];
    const emaSlowPath: number[] = [];

    // Seed slow
    let emaSlow = closes.slice(0, slowPeriod).reduce((a, b) => a + b, 0) / slowPeriod;
    let emaFast = closes.slice(slowPeriod - fastPeriod, slowPeriod).reduce((a, b) => a + b, 0) / fastPeriod;

    // Track MacdLine for signal calculation
    const macdLineArr: number[] = [];

    const kFast = 2 / (fastPeriod + 1);
    const kSlow = 2 / (slowPeriod + 1);

    for (let i = slowPeriod; i < closes.length; i++) {
        emaFast = (closes[i] - emaFast) * kFast + emaFast;
        emaSlow = (closes[i] - emaSlow) * kSlow + emaSlow;
        macdLineArr.push(emaFast - emaSlow);
    }

    const macdLine = macdLineArr[macdLineArr.length - 1];

    // Compute Signal Line (9-period EMA of MACD Line)
    if (macdLineArr.length < signalPeriod) {
        return { macd: macdLine, signal: macdLine, hist: 0 };
    }

    let signalLine = macdLineArr.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
    const kSignal = 2 / (signalPeriod + 1);

    for (let i = signalPeriod; i < macdLineArr.length; i++) {
        signalLine = (macdLineArr[i] - signalLine) * kSignal + signalLine;
    }

    return {
        macd: macdLine,
        signal: signalLine,
        hist: macdLine - signalLine
    };
}

/**
 * Compute Average True Range (ATR)
 */
function computeATR(bars: AlpacaBar[], period: number = 14): number {
    if (bars.length < period + 1) return 0;

    const trs: number[] = [];
    for (let i = 1; i < bars.length; i++) {
        const high = bars[i].h;
        const low = bars[i].l;
        const prevClose = bars[i - 1].c;
        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        trs.push(tr);
    }

    // Smoothed moving average (Wilder's)
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
}

// ── Main Scorer ───────────────────────────────────────────────────────────────

/**
 * Score a stock given its historical daily bars.
 * Requires at least 60 bars for reliable EMA50 computation.
 */
export function scoreStock(symbol: string, bars: AlpacaBar[]): IndicatorResult {
    if (bars.length < 20) {
        return {
            symbol,
            currentPrice: bars.at(-1)?.c ?? 0,
            rsi14: 50,
            ema50: bars.at(-1)?.c ?? 0,
            ema200: bars.at(-1)?.c ?? 0,
            macd: 0, macdSignal: 0, macdHist: 0,
            atr14: 0,
            avgVolume20: 0,
            currentVolume: bars.at(-1)?.v ?? 0,
            volumeRatio: 1,
            volumeSurge: false,
            macdCrossover: false,
            emaCrossover: false,
            priceAboveEma: false,
            score: 0,
            signal: "HOLD",
            reason: `Insufficient data (${bars.length} bars, need 20+)`,
            canBuy: false,
        };
    }

    const closes = bars.map(b => b.c);
    const volumes = bars.map(b => b.v);

    const currentPrice = closes.at(-1)!;
    const currentVolume = volumes.at(-1)!;

    const rsi14 = computeRSI(closes, 14);
    const ema50 = computeEMA(closes, Math.min(50, closes.length));
    // EMA200: use longest possible period (capped at available data)
    const ema200 = computeEMA(closes, Math.min(200, closes.length));
    const { macd, signal: macdSignal, hist: macdHist } = computeMACD(closes);
    const atr14 = computeATR(bars, 14);
    const avgVolume20 = computeAvgVolume(volumes.slice(0, -1), 20); // exclude today for avg
    const volumeRatio = currentVolume / avgVolume20;
    const priceAboveEma = currentPrice > ema50;

    // ── Multi-Factor Scoring ──────────────────────────────────────────────
    const volumeSurge = volumeRatio > 1.5;         // Volume surge: >1.5× 20-day avg
    const macdCrossover = macd > macdSignal;        // MACD line above Signal line
    const emaCrossover = ema50 > ema200;            // EMA50 > EMA200 (uptrend)

    const baseResult = {
        symbol, currentPrice, rsi14, ema50, ema200, macd, macdSignal, macdHist, atr14,
        avgVolume20, currentVolume, volumeRatio, volumeSurge, macdCrossover, emaCrossover, priceAboveEma,
    };

    // ── Exit Signals (checked first — if you hold this, should you sell?) ──
    if (rsi14 > 70) {
        return {
            ...baseResult,
            score: 0,
            signal: "SELL_OVERBOUGHT",
            reason: `RSI ${rsi14.toFixed(1)} > 70 — overbought, take profit`,
            canBuy: false,
        };
    }

    // ── Multi-Factor Score Calculation (0-6 points) ───────────────────────
    let score = 0;
    const scoreBreakdown: string[] = [];

    // Factor 1: RSI — deeply oversold gets +2, moderately oversold gets +1
    if (rsi14 < 35) {
        score += 2;
        scoreBreakdown.push(`RSI ${rsi14.toFixed(1)}<35 (+2)`);
    } else if (rsi14 >= 35 && rsi14 <= 55) {
        score += 1;
        scoreBreakdown.push(`RSI ${rsi14.toFixed(1)} in 35-55 (+1)`);
    }

    // Factor 2: EMA Crossover — uptrend confirmation
    if (emaCrossover) {
        score += 1;
        scoreBreakdown.push(`EMA50>EMA200 uptrend (+1)`);
    }

    // Factor 3: Volume Surge — institutional interest
    if (volumeSurge) {
        score += 1;
        scoreBreakdown.push(`VolSurge ${volumeRatio.toFixed(1)}× (+1)`);
    }

    // Factor 4: MACD positive momentum
    if (macdHist > 0) {
        score += 1;
        scoreBreakdown.push(`MACD Hist>0 (+1)`);
    }

    // Factor 5: Price above EMA50 (Short-term momentum)
    if (priceAboveEma) {
        score += 1;
        scoreBreakdown.push(`Price>EMA50 (+1)`);
    }

    // ── BUY Signal: score >= 3 ────────────────────────────────────────────
    if (score >= 3) {
        return {
            ...baseResult,
            score,
            signal: "BUY",
            reason: `✅ Score ${score}/6: ${scoreBreakdown.join(", ")}`,
            canBuy: true,
        };
    }

    // ── Hold — score too low for entry ─────────────────────────────────────
    const holdReasons: string[] = [];
    if (rsi14 > 55) holdReasons.push(`RSI ${rsi14.toFixed(1)} > 55`);
    if (!emaCrossover) holdReasons.push(`EMA50<EMA200 (downtrend)`);
    if (macdHist <= 0) holdReasons.push(`MACD Hist negative`);
    if (!volumeSurge) holdReasons.push(`No volume surge`);

    return {
        ...baseResult,
        score,
        signal: "HOLD",
        reason: `Hold (Score ${score}/6) — ${holdReasons.slice(0, 3).join("; ")}`,
        canBuy: false,
    };
}

/**
 * Apply hard quality gates for buy entries to avoid weak counter-trend setups.
 * This is stricter than the raw score to reduce low-conviction trades.
 */
export function validateBuySetup(indicators: IndicatorResult, minScore: number = 3): BuySetupVerdict {
    if (!indicators.canBuy || indicators.signal !== "BUY" || indicators.score < minScore) {
        return {
            valid: false,
            reason: `Score ${indicators.score}/6 below required quality threshold (${minScore}/6).`,
        };
    }

    if (!indicators.emaCrossover) {
        return {
            valid: false,
            reason: "Trend filter failed: EMA50 is below EMA200.",
        };
    }

    if (!indicators.macdCrossover || indicators.macdHist <= 0) {
        return {
            valid: false,
            reason: "Momentum filter failed: MACD is not in bullish crossover.",
        };
    }

    if (indicators.currentPrice < indicators.ema50 * 0.98) {
        return {
            valid: false,
            reason: "Price action filter failed: price is materially below EMA50.",
        };
    }

    if (indicators.volumeRatio < 0.9) {
        return {
            valid: false,
            reason: `Liquidity filter failed: volume ratio ${indicators.volumeRatio.toFixed(2)}x is too weak.`,
        };
    }

    if (indicators.currentPrice <= 0 || indicators.atr14 <= 0) {
        return {
            valid: false,
            reason: "Volatility filter failed: invalid ATR/current price.",
        };
    }

    const atrPct = indicators.atr14 / indicators.currentPrice;
    if (!Number.isFinite(atrPct) || atrPct > 0.08) {
        return {
            valid: false,
            reason: `Volatility filter failed: ATR is ${(atrPct * 100).toFixed(2)}% of price (>8%).`,
        };
    }

    return {
        valid: true,
        reason: `Quality checks passed (score ${indicators.score}/6, ATR ${(atrPct * 100).toFixed(2)}%).`,
    };
}

// ── Position Exit Checker ─────────────────────────────────────────────────────

export interface ExitVerdict {
    shouldExit: boolean;
    reason: string;
}

/**
 * Given a current position's unrealized P/L percentage and the latest indicator
 * result, determine if we should exit.
 */
export function checkExitCondition(
    indicators: IndicatorResult,
    unrealizedPlpc: number  // e.g. -0.08 = -8%, 0.10 = +10%
): ExitVerdict {
    // ── ATR-based dynamic stop-loss ──────────────────────────────────────
    // Use ATR to determine volatility-adjusted stop loss
    const atrPct = indicators.atr14 / indicators.currentPrice; // ATR as % of price
    const dynamicStopLoss = -(atrPct * 2); // 2×ATR stop-loss (typically ~3-8%)

    // Hard stop-loss: max of dynamic ATR stop or -7% absolute floor
    const effectiveStop = Math.max(dynamicStopLoss, -0.07);

    if (unrealizedPlpc <= effectiveStop) {
        return { shouldExit: true, reason: `ATR-based stop-loss hit: ${(unrealizedPlpc * 100).toFixed(2)}% loss (stop at ${(effectiveStop * 100).toFixed(1)}%, ATR=$${indicators.atr14.toFixed(2)})` };
    }

    // ── Dynamic take-profit at +10% ─────────────────────────────────────
    if (unrealizedPlpc >= 0.10) {
        return { shouldExit: true, reason: `Take-profit hit: +${(unrealizedPlpc * 100).toFixed(2)}% gain (target: 10%)` };
    }

    // ── RSI overbought exit ──────────────────────────────────────────────
    if (indicators.signal === "SELL_OVERBOUGHT") {
        return { shouldExit: true, reason: indicators.reason };
    }
    if (indicators.signal === "SELL_TREND_BREAK") {
        return { shouldExit: true, reason: indicators.reason };
    }

    // ── Tighter trailing for profitable trades ──────────────────────────
    // When in profit > +5%, recommend tightening the trailing stop
    if (unrealizedPlpc >= 0.05) {
        return { shouldExit: false, reason: `Profitable +${(unrealizedPlpc * 100).toFixed(1)}% — TIGHTEN trailing stop to 1.5×ATR ($${(indicators.atr14 * 1.5).toFixed(2)})` };
    }

    return { shouldExit: false, reason: "Hold — no exit condition triggered" };
}
