/**
 * Trading Tools â€” LLM-callable tools for interacting with Alpaca.
 * Registered into the global tool registry so the agent loop can use them.
 */
import { registerTool } from "../tools/index.js";
import * as alpaca from "./alpaca.js";
import { logTrade, getTradesSince } from "./journal.js";
import { scoreStock, checkExitCondition, validateBuySetup } from "./strategy.js";
import { runWatchlistScreen, formatScreenResult } from "./screener.js";
import { getSector, isSectorLimitReached } from "./sectors.js";
import { estimateRoundTripFeeUsd, estimateTradingFeeUsd, formatCurrentFeeTierSummary, getTradingFeeRate, isDailyLossLimitBreached } from "./risk-controls.js";
import { config } from "../config.js";

type TradingExecutionContext = "default" | "light" | "ultra_light";
let tradingExecutionContext: TradingExecutionContext = "default";

export function setTradingExecutionContext(context: TradingExecutionContext): void {
    tradingExecutionContext = context;
}

function isStaleBarsError(err: unknown): boolean {
    return err instanceof Error && err.message.includes("Stale market bars");
}

function roundDownQty(value: number, decimals = 6): number {
    const factor = 10 ** decimals;
    return Math.floor(value * factor) / factor;
}

function hasFractionalQty(value: number): boolean {
    return Math.abs(value - Math.trunc(value)) > 1e-9;
}

// â”€â”€ get_account â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

registerTool(
    "get_account",
    "Get your Alpaca trading account info: buying power, equity, portfolio value, cash.",
    {
        type: "object",
        properties: {},
        required: [],
    },
    async () => {
        try {
            const account = await alpaca.getAccount();
            const sampleNotional = 1000;
            const sampleOrderFee = estimateTradingFeeUsd(sampleNotional, "taker");
            const sampleRoundTripFee = estimateRoundTripFeeUsd(sampleNotional, sampleNotional, "maker", "taker");
            return [
                `ðŸ’° Account Status: ${account.status}`,
                `   Equity:       $${account.equity}`,
                `   Cash:         $${account.cash}`,
                `   Buying Power: $${account.buying_power}`,
                `   Portfolio:    $${account.portfolio_value}`,
                `   Day Trades:   ${account.daytrade_count}`,
                `   PDT Flag:     ${account.pattern_day_trader}`,
                `   Fees:         ${formatCurrentFeeTierSummary()}`,
                `   Fee Example:  ~$${sampleOrderFee.toFixed(2)} taker per $${sampleNotional.toFixed(0)} order | ~$${sampleRoundTripFee.toFixed(2)} maker+taker round-trip`,
            ].join("\n");
        } catch (err: any) {
            return `Error fetching account: ${err.message}`;
        }
    }
);

// â”€â”€ get_positions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

registerTool(
    "get_positions",
    "Get all open stock positions with current P/L. Shows symbol, qty, entry price, current price, and unrealized profit/loss.",
    {
        type: "object",
        properties: {},
        required: [],
    },
    async () => {
        try {
            const positions = await alpaca.getPositions();
            if (positions.length === 0) return "No open positions.";

            return positions.map(p => {
                const plPct = (parseFloat(p.unrealized_plpc) * 100).toFixed(2);
                const plSign = parseFloat(p.unrealized_pl) >= 0 ? "ðŸ“ˆ" : "ðŸ“‰";
                return [
                    `${plSign} ${p.symbol}: ${p.qty} shares`,
                    `   Entry: $${p.avg_entry_price} â†’ Current: $${p.current_price}`,
                    `   P/L: $${p.unrealized_pl} (${plPct}%)`,
                    `   Market Value: $${p.market_value}`,
                ].join("\n");
            }).join("\n\n");
        } catch (err: any) {
            return `Error fetching positions: ${err.message}`;
        }
    }
);

// â”€â”€ place_order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

registerTool(
    "place_order",
    "Place a stock order on Alpaca. Supports market, limit, stop, and trailing_stop orders. BUY or SELL. No leverage, no short selling.",
    {
        type: "object",
        properties: {
            symbol: { type: "string", description: "Stock ticker symbol (e.g. AAPL, MSFT, TSLA)" },
            qty: { type: "number", description: "Number of shares to buy or sell" },
            side: { type: "string", enum: ["buy", "sell"], description: "Buy or sell" },
            type: { type: "string", enum: ["market", "limit", "trailing_stop", "stop"], description: "Order type (default: market)" },
            limit_price: { type: "number", description: "Limit price (required for limit orders)" },
            stop_price: { type: "number", description: "Stop price (required for stop orders). Used for stop-loss orders." },
            trail_percent: { type: "number", description: "Optional: Trailing stop percentage (e.g. 5.0 for 5%). Use this OR trail_price, not both." },
            trail_price: { type: "number", description: "Optional: Trailing stop dollar amount (e.g. 3.50 for $3.50 trail). Preferred over trail_percent â€” calculate as 2 Ã— ATR from screener." },
            extended_hours: { type: "boolean", description: "Set true for eligible LIMIT DAY orders placed outside regular market hours." },
            reasoning: { type: "string", description: "Your reasoning for this trade" },
        },
        required: ["symbol", "qty", "side"],
    },
    async (input) => {
        try {
            const symbol = (input.symbol as string).toUpperCase();
            const requestedQty = Number(input.qty);
            if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
                return `âš ï¸ Invalid qty "${input.qty}" for ${symbol}. Quantity must be > 0.`;
            }
            let qty = requestedQty;
            const side = input.side as "buy" | "sell";
            const type = (input.type as "market" | "limit" | "trailing_stop" | "stop") || "market";
            const limitPrice = input.limit_price as number | undefined;
            const stopPrice = input.stop_price as number | undefined;
            const trailPercent = input.trail_percent as number | undefined;
            const trailPrice = input.trail_price as number | undefined;
            const extendedHours = Boolean(input.extended_hours);
            const reasoning = (input.reasoning as string) || "";
            const asset = await alpaca.getAsset(symbol).catch(() => null);
            const supportsFractionalMarket = Boolean(
                config.alpacaAllowFractionalShares &&
                asset?.fractionable &&
                type === "market" &&
                !extendedHours
            );

            if ((tradingExecutionContext === "light" || tradingExecutionContext === "ultra_light") && side === "buy") {
                return "RISK GUARD BLOCKED: Fast cycle cannot open new buy positions.";
            }

            // Safety: no short selling
            if (side === "sell") {
                try {
                    const openOrders = await alpaca.getOrders("open");
                    if (type !== "market") {
                        const existingSameExit = openOrders.find(o =>
                            o.symbol === symbol && o.side === "sell" && o.type === type
                        );
                        if (existingSameExit) {
                            return `RISK GUARD BLOCKED: Duplicate ${type} exit already open for ${symbol} (${existingSameExit.id}).`;
                        }
                    }

                    const pos = await alpaca.getPosition(symbol);
                    const qtyHeld = parseFloat(pos.qty);
                    const qtyAvailable = parseFloat((pos as any).qty_available ?? pos.qty);
                    if (qtyHeld <= 0) {
                        return `RISK GUARD BLOCKED: Cannot sell ${symbol} - no position held.`;
                    }
                    if (qtyAvailable <= 0) {
                        return `RISK GUARD BLOCKED: Cannot sell ${symbol} right now - shares are reserved by open sell orders.`;
                    }
                    if (qty > qtyAvailable) {
                        qty = qtyAvailable;
                    }
                } catch {
                    return `RISK GUARD BLOCKED: Cannot sell ${symbol} - you do not have a position. No short selling allowed.`;
                }
            }

            // Buy-side hard risk constraints (cash-only, max 10% position size, PDT, sector)
            if (side === "buy") {
                try {
                    const openOrders = await alpaca.getOrders("open");
                    const existingBuy = openOrders.find(o =>
                        o.symbol === symbol && o.side === "buy"
                    );
                    if (existingBuy) {
                        return `RISK GUARD BLOCKED: Existing buy order already open for ${symbol} (${existingBuy.id}).`;
                    }
                    const openBuyOrders = openOrders.filter(o => o.side === "buy");
                    const positions = await alpaca.getPositions();
                    const totalExposureSlots = positions.length + openBuyOrders.length;
                    if (totalExposureSlots >= 7) {
                        return `RISK GUARD BLOCKED: Max exposure reached (${totalExposureSlots}/7 open positions+buy orders).`;
                    }

                    const exposureSymbols = new Set<string>([
                        ...positions.map((p) => p.symbol),
                        ...openBuyOrders.map((o) => o.symbol),
                    ]);
                    const sectorCheck = isSectorLimitReached(Array.from(exposureSymbols), symbol, 2);
                    if (sectorCheck.blocked) {
                        return `SECTOR LIMIT: Cannot buy ${symbol} [${sectorCheck.sector}] - already ${sectorCheck.count} positions/orders in this sector (max 2).`;
                    }

                    const account = await alpaca.getAccount();
                    const equity = parseFloat(account.equity);
                    const cash = parseFloat(account.cash);
                    const latestPrice = await alpaca.getLatestTrade(symbol);
                    const currentPrice = latestPrice.p;
                    const bars = await alpaca.getBars(symbol, "1Day", 60, { allowStale: true });
                    if (bars.length < 20) {
                        return `RISK GUARD BLOCKED: Insufficient market data (${bars.length} bars) for ${symbol}.`;
                    }
                    const indicators = scoreStock(symbol, bars);
                    const buySetup = validateBuySetup(indicators, 3);
                    if (!buySetup.valid) {
                        return `RISK GUARD BLOCKED: ${buySetup.reason}`;
                    }
                    const estimatedEntryPrice = type === "limit" && Number.isFinite(limitPrice) ? Number(limitPrice) : currentPrice;
                    const requestedValue = qty * estimatedEntryPrice;
                    const maxPositionValue = equity * 0.10;

                    if (isDailyLossLimitBreached()) {
                        return `RISK GUARD BLOCKED: Daily loss limit reached. No new BUY orders today.`;
                    }

                    if (cash <= 0) {
                        return `RISK GUARD BLOCKED: Cannot buy ${symbol} - cash is ${account.cash}. Cash-only mode active (no margin).`;
                    }

                    if (requestedValue > maxPositionValue) {
                        const cappedQty = supportsFractionalMarket
                            ? roundDownQty(maxPositionValue / currentPrice)
                            : Math.floor(maxPositionValue / currentPrice);
                        if (cappedQty <= 0) {
                            return `RISK GUARD BLOCKED: ${symbol} exceeds 10% max position and capped qty is 0.`;
                        }
                        qty = cappedQty;
                    }

                    // Do not spend more cash than available.
                    const takerFeeRate = getTradingFeeRate("taker");
                    const affordableQty = supportsFractionalMarket
                        ? roundDownQty(cash / (estimatedEntryPrice * (1 + takerFeeRate)))
                        : Math.floor(cash / (estimatedEntryPrice * (1 + takerFeeRate)));
                    if (affordableQty <= 0) {
                        return `RISK GUARD BLOCKED: Not enough cash to buy ${symbol} at $${estimatedEntryPrice.toFixed(2)} including estimated taker fee ${(takerFeeRate * 100).toFixed(2)}%.`;
                    }
                    if (qty > affordableQty) {
                        qty = affordableQty;
                    }

                    if (account.daytrade_count >= 3) {
                        const today = new Date().toISOString().split("T")[0];
                        const todayTrades = getTradesSince(today);
                        const soldToday = todayTrades.some(t => t.symbol === symbol && t.side === "sell");
                        if (soldToday) {
                            return `PDT GUARD BLOCKED: Cannot buy ${symbol} - sold today and day_trade_count=${account.daytrade_count}.`;
                        }
                    }
                } catch (e: any) {
                    console.error(`PDT/risk check failed:`, e.message);
                    return `RISK GUARD BLOCKED: Risk check failed for ${symbol} (${e.message}).`;
                }
            }

            if (side === "buy" && config.alpacaAllowFractionalShares && type !== "market" && qty < 1) {
                return `RISK GUARD BLOCKED: Fractional buys for ${symbol} require type \"market\" on Alpaca.`;
            }

            if (hasFractionalQty(qty)) {
                if (!config.alpacaAllowFractionalShares) {
                    return `RISK GUARD BLOCKED: Fractional quantity ${qty} is disabled for this runtime.`;
                }
                if (!(asset?.fractionable)) {
                    return `RISK GUARD BLOCKED: ${symbol} is not fractionable on Alpaca.`;
                }
                if (type !== "market") {
                    return `RISK GUARD BLOCKED: Fractional orders for ${symbol} must use type \"market\".`;
                }
                if (extendedHours) {
                    return `RISK GUARD BLOCKED: Fractional orders for ${symbol} cannot use extended_hours.`;
                }
                qty = roundDownQty(qty);
                if (qty <= 0) {
                    return `RISK GUARD BLOCKED: Fractional quantity rounded to 0 for ${symbol}.`;
                }
            } else {
                qty = Math.floor(qty);
            }

            // Trailing stops and stop orders should use GTC so they don't expire at end of day
            let timeInForce: "day" | "gtc" = (type === "trailing_stop" || type === "stop") ? "gtc" : "day";
            if (extendedHours) {
                if (type !== "limit") {
                    return "RISK GUARD BLOCKED: extended_hours is only valid for LIMIT orders.";
                }
                timeInForce = "day";
            }

            const order = await alpaca.placeOrder({
                symbol,
                qty,
                side,
                type,
                time_in_force: timeInForce,
                limit_price: type === "limit" ? limitPrice : undefined,
                stop_price: type === "stop" ? stopPrice : undefined,
                trail_percent: type === "trailing_stop" && trailPercent ? String(trailPercent) : undefined,
                trail_price: type === "trailing_stop" && trailPrice ? String(trailPrice) : undefined,
                extended_hours: extendedHours || undefined,
            });

            // Log to trade journal
            logTrade(
                symbol,
                side,
                qty,
                limitPrice || null,
                type,
                order.id,
                reasoning,
                order.status
            );

            const notionalForFee = type === "limit" && Number.isFinite(limitPrice)
                ? qty * Number(limitPrice)
                : 0;
            const estimatedFee = notionalForFee > 0 ? estimateTradingFeeUsd(notionalForFee, "taker") : 0;

            return [
                `OK: Order placed successfully.`,
                `   ID:     ${order.id}`,
                `   ${side.toUpperCase()} ${qty}x ${symbol}${qty !== requestedQty ? ` (adjusted from ${requestedQty})` : ""}`,
                `   Type:   ${type}${type === "limit" ? ` @ $${limitPrice}` : ""}${type === "stop" ? ` @ $${stopPrice}` : ""}${type === "trailing_stop" ? ` (Trail: ${trailPrice ? '$' + trailPrice : trailPercent + '%'})` : ""}`,
                `   TIF:    ${timeInForce}`,
                `   ExtHrs: ${extendedHours ? "true" : "false"}`,
                `   Fee:    ${notionalForFee > 0 ? `~$${estimatedFee.toFixed(2)} (estimated taker)` : "dynamic tier applies (notional unknown)"}`,
                `   Status: ${order.status}`,
            ].join("\n");
        } catch (err: any) {
            return `ERROR: Order failed: ${err.message}`;
        }
    }
);

// â”€â”€ cancel_order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

registerTool(
    "cancel_order",
    "Cancel a pending order by its order ID.",
    {
        type: "object",
        properties: {
            order_id: { type: "string", description: "The Alpaca order ID to cancel" },
        },
        required: ["order_id"],
    },
    async (input) => {
        try {
            await alpaca.cancelOrder(input.order_id as string);
            return `âœ… Order ${input.order_id} cancelled.`;
        } catch (err: any) {
            return `âŒ Cancel failed: ${err.message}`;
        }
    }
);

// â”€â”€ get_orders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

registerTool(
    "get_orders",
    "Get recent orders. Defaults to open orders. Use status 'closed' or 'all' to see more.",
    {
        type: "object",
        properties: {
            status: { type: "string", enum: ["open", "closed", "all"], description: "Order status filter (default: open)" },
        },
        required: [],
    },
    async (input) => {
        try {
            const status = (input.status as "open" | "closed" | "all") || "open";
            const orders = await alpaca.getOrders(status);
            if (orders.length === 0) return `No ${status} orders.`;

            return orders.slice(0, 15).map(o => {
                return [
                    `${o.side.toUpperCase()} ${o.qty}x ${o.symbol} (${o.type}) â€” Status: ${o.status}${o.filled_avg_price ? ` @ $${o.filled_avg_price}` : ""}`,
                    `ID: ${o.id}`,
                ].join("\n");
            }).join("\n");
        } catch (err: any) {
            return `Error fetching orders: ${err.message}`;
        }
    }
);

// â”€â”€ get_market_data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

registerTool(
    "get_market_data",
    "Get recent daily price bars for a stock symbol (last 10 days by default). Shows open, high, low, close, volume.",
    {
        type: "object",
        properties: {
            symbol: { type: "string", description: "Stock ticker symbol (e.g. AAPL)" },
            days: { type: "number", description: "Number of days of history (default: 10, max: 30)" },
        },
        required: ["symbol"],
    },
    async (input) => {
        try {
            const symbol = (input.symbol as string).toUpperCase();
            const days = Math.min((input.days as number) || 10, 30);
            const bars = await alpaca.getBars(symbol, "1Day", days);

            if (bars.length === 0) return `No price data found for ${symbol}.`;

            const header = `ðŸ“Š ${symbol} â€” Last ${bars.length} trading days:`;
            const rows = bars.map(b => {
                const date = b.t.slice(0, 10);
                return `${date} | O:$${b.o.toFixed(2)} H:$${b.h.toFixed(2)} L:$${b.l.toFixed(2)} C:$${b.c.toFixed(2)} V:${(b.v / 1000).toFixed(0)}K`;
            });

            return [header, ...rows].join("\n");
        } catch (err: any) {
            return `Error fetching market data: ${err.message}`;
        }
    }
);

// â”€â”€ get_latest_price â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

registerTool(
    "get_latest_price",
    "Get the current/latest trade price for a stock symbol.",
    {
        type: "object",
        properties: {
            symbol: { type: "string", description: "Stock ticker symbol (e.g. AAPL)" },
        },
        required: ["symbol"],
    },
    async (input) => {
        try {
            const symbol = (input.symbol as string).toUpperCase();
            const trade = await alpaca.getLatestTrade(symbol);
            return `ðŸ’µ ${symbol}: $${trade.p.toFixed(2)} (size: ${trade.s})`;
        } catch (err: any) {
            return `Error fetching price: ${err.message}`;
        }
    }
);

// â”€â”€ calculate_indicators â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

registerTool(
    "calculate_indicators",
    "Compute RSI(14), EMA(50), and volume ratio for a stock using 60 days of real price data from Alpaca. Returns a BUY/SELL/HOLD signal with human-readable reasoning based on the RSI Mean-Reversion + EMA Trend strategy.",
    {
        type: "object",
        properties: {
            symbol: { type: "string", description: "Stock ticker symbol (e.g. AAPL, NVDA)" },
            unrealized_plpc: {
                type: "number",
                description: "Optional: unrealized P/L percentage as decimal (e.g. -0.05 for -5%) â€” used to check stop-loss/take-profit exit conditions for an existing position."
            },
        },
        required: ["symbol"],
    },
    async (input) => {
        try {
            const symbol = (input.symbol as string).toUpperCase();
            let staleWarning = "";
            let bars: alpaca.AlpacaBar[];
            try {
                bars = await alpaca.getBars(symbol, "1Day", 60);
            } catch (err: any) {
                if (!isStaleBarsError(err)) {
                    throw err;
                }
                bars = await alpaca.getBars(symbol, "1Day", 60, { allowStale: true });
                staleWarning = `   Warning: stale daily bars detected - using last available daily bars for ${symbol}.`;
            }

            if (bars.length < 20) {
                return `âš ï¸ Not enough price data for ${symbol} (${bars.length} bars, need 20+).`;
            }

            const result = scoreStock(symbol, bars);

            const lines = [
                `ðŸ“Š **${symbol} [${getSector(symbol)}] â€” Technical Indicators**`,
                `   Price:        $${result.currentPrice.toFixed(2)}`,
                `   RSI(14):      ${result.rsi14.toFixed(2)}`,
                `   EMA(50):      $${result.ema50.toFixed(2)}`,
                `   EMA(200):     $${result.ema200.toFixed(2)} ${result.emaCrossover ? 'âœ… EMA50>200' : 'âŒ EMA50<200'}`,
                `   MACD:         ${result.macdCrossover ? 'âœ… Crossover' : 'âŒ Below Signal'} (Hist: ${result.macdHist.toFixed(3)})`,
                `   ATR(14):      $${result.atr14.toFixed(2)}`,
                `   Avg Vol(20d): ${(result.avgVolume20 / 1000).toFixed(0)}K`,
                `   Today Vol:    ${(result.currentVolume / 1000).toFixed(0)}K (${result.volumeRatio.toFixed(2)}Ã— avg) ${result.volumeSurge ? 'ðŸŸ¢ SURGE' : ''}`,
                `   Score:        ${result.score}/6`,
                ``,
                `   Signal: **${result.signal}**`,
                `   Reason: ${result.reason}`,
            ];

            if (staleWarning) {
                lines.splice(1, 0, staleWarning);
            }

            // If caller provided current P/L, also check exit conditions
            if (typeof input.unrealized_plpc === "number") {
                const exit = checkExitCondition(result, input.unrealized_plpc as number);
                lines.push(``, `   Exit Check: ${exit.shouldExit ? "âš ï¸ EXIT â€” " + exit.reason : "âœ… Keep holding â€” " + exit.reason}`);
            }

            return lines.join("\n");
        } catch (err: any) {
            return `Error computing indicators for ${input.symbol}: ${err.message}`;
        }
    }
);

// â”€â”€ screen_watchlist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

registerTool(
    "screen_watchlist",
    "Run the full S&P 500 watchlist screen. Fetches 60 days of price data per stock, computes multi-factor scores (RSI, EMA crossover, volume surge, MACD) and returns all BUY signals (sorted by score), SELL signals, and HOLD stocks with sector tags. This is the primary tool for finding trade setups â€” call this first every cycle.",
    {
        type: "object",
        properties: {},
        required: [],
    },
    async () => {
        if (tradingExecutionContext === "light" || tradingExecutionContext === "ultra_light") {
            return "RISK GUARD BLOCKED: screen_watchlist is disabled during fast cycles.";
        }
        try {
            const screen = await runWatchlistScreen();
            return formatScreenResult(screen);
        } catch (err: any) {
            return `Error running watchlist screen: ${err.message}`;
        }
    }
);
