/**
 * Alpaca REST API Client — lightweight wrapper using native fetch.
 * Paper trading only. No npm dependency needed.
 */
import { config } from "../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AlpacaAccount {
    id: string;
    status: string;
    buying_power: string;
    cash: string;
    portfolio_value: string;
    equity: string;
    last_equity: string;
    long_market_value: string;
    short_market_value: string;
    trading_blocked: boolean;
    pattern_day_trader: boolean;
    daytrade_count: number;
    currency: string;
}

export interface AlpacaPosition {
    asset_id: string;
    symbol: string;
    qty: string;
    avg_entry_price: string;
    current_price: string;
    market_value: string;
    unrealized_pl: string;
    unrealized_plpc: string;
    side: string;
}

export interface AlpacaOrder {
    id: string;
    client_order_id: string;
    symbol: string;
    qty: string;
    filled_qty: string;
    side: "buy" | "sell";
    type: "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";
    time_in_force: string;
    limit_price?: string;
    stop_price?: string;
    status: string;
    filled_avg_price?: string;
    created_at: string;
    updated_at: string;
    submitted_at: string;
    filled_at?: string;
}

export interface OrderRequest {
    symbol: string;
    qty: number;
    side: "buy" | "sell";
    type: "market" | "limit" | "trailing_stop" | "stop";
    time_in_force: "day" | "gtc" | "ioc" | "fok";
    limit_price?: number;
    trail_percent?: string;
    trail_price?: string;
    stop_price?: number;
    extended_hours?: boolean;
}

export interface AlpacaBar {
    t: string;  // timestamp
    o: number;  // open
    h: number;  // high
    l: number;  // low
    c: number;  // close
    v: number;  // volume
}

export interface AlpacaLatestTrade {
    t: string;
    p: number;  // price
    s: number;  // size
}

interface GetBarsOptions {
    allowStale?: boolean;
}

export interface AlpacaAsset {
    id: string;
    symbol: string;
    name: string;
    exchange: string;
    status: string;
    tradable: boolean;
    fractionable: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const headers = () => ({
    "APCA-API-KEY-ID": config.alpacaApiKey,
    "APCA-API-SECRET-KEY": config.alpacaApiSecret,
    "Content-Type": "application/json",
});

function getRequestTimeoutMs(): number {
    const value = Math.floor(config.alpacaRequestTimeoutMs);
    if (!Number.isFinite(value) || value < 1000) return 12000;
    return value;
}

function getMaxBarStalenessHours(): number {
    const value = Math.floor(config.maxBarStalenessHours);
    if (!Number.isFinite(value)) return 120;
    return Math.min(336, Math.max(24, value));
}

function getBarAgeHours(lastTs?: string): number {
    if (!lastTs) return Number.POSITIVE_INFINITY;
    const ms = Date.parse(lastTs);
    if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
    return Math.max(0, Date.now() - ms) / (1000 * 60 * 60);
}

async function alpacaFetch<T>(path: string, options?: RequestInit): Promise<T> {
    // Market data paths (/v2/stocks/...) go to data.alpaca.markets
    // Trading paths (/v2/account, /v2/orders, /v2/positions) go to paper-api.alpaca.markets
    const isMarketData = path.startsWith("/v2/stocks");
    const baseUrl = isMarketData ? config.alpacaDataUrl : config.alpacaBaseUrl;
    const url = `${baseUrl}${path}`;
    const timeoutMs = getRequestTimeoutMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
        res = await fetch(url, {
            ...options,
            headers: { ...headers(), ...(options?.headers || {}) },
            signal: controller.signal,
        });
    } catch (err: any) {
        if (err?.name === "AbortError") {
            throw new Error(`Alpaca API timeout after ${timeoutMs}ms for ${path}`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }

    if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        throw new Error(`Alpaca API ${res.status}: ${res.statusText} — ${errorBody}`);
    }

    // DELETE on cancel returns 204 No Content
    if (res.status === 204) return {} as T;

    return res.json() as Promise<T>;
}

// ── Trading API (paper-api.alpaca.markets) ───────────────────────────────────

/** Get account info (buying power, equity, etc.) */
export async function getAccount(): Promise<AlpacaAccount> {
    return alpacaFetch<AlpacaAccount>("/v2/account");
}

/** Get all open positions */
export async function getPositions(): Promise<AlpacaPosition[]> {
    return alpacaFetch<AlpacaPosition[]>("/v2/positions");
}

/** Get position for a specific symbol */
export async function getPosition(symbol: string): Promise<AlpacaPosition> {
    return alpacaFetch<AlpacaPosition>(`/v2/positions/${encodeURIComponent(symbol)}`);
}

/** Place a new order */
export async function placeOrder(order: OrderRequest): Promise<AlpacaOrder> {
    return alpacaFetch<AlpacaOrder>("/v2/orders", {
        method: "POST",
        body: JSON.stringify(order),
    });
}

/** Get orders (defaults to open) */
export async function getOrders(status: "open" | "closed" | "all" = "open"): Promise<AlpacaOrder[]> {
    return alpacaFetch<AlpacaOrder[]>(`/v2/orders?status=${status}&limit=50`);
}

/** Cancel a specific order */
export async function cancelOrder(orderId: string): Promise<void> {
    await alpacaFetch<void>(`/v2/orders/${orderId}`, { method: "DELETE" });
}

/** Cancel all open orders */
export async function cancelAllOrders(): Promise<void> {
    await alpacaFetch<void>("/v2/orders", { method: "DELETE" });
}

/** Get asset info for a symbol */
export async function getAsset(symbol: string): Promise<AlpacaAsset> {
    return alpacaFetch<AlpacaAsset>(`/v2/assets/${encodeURIComponent(symbol)}`);
}

// ── Market Data API (data.alpaca.markets) ────────────────────────────────────

/** Get historical price bars for a symbol */
export async function getBars(
    symbol: string,
    timeframe: string = "1Day",
    limit: number = 30,
    options: GetBarsOptions = {}
): Promise<AlpacaBar[]> {
    // Alpaca needs a start date to return multiple bars
    // Add extra calendar days to account for weekends/holidays
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - Math.ceil(limit * 1.6));
    const start = startDate.toISOString().split("T")[0];
    const end = new Date().toISOString();

    const url = `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&start=${start}&end=${encodeURIComponent(end)}&limit=${limit}&feed=iex&sort=asc`;
    const data = await alpacaFetch<{ bars: AlpacaBar[] }>(url);
    const bars = data.bars || [];
    const maxBarAgeHours = getMaxBarStalenessHours();
    const ageHours = getBarAgeHours(bars.at(-1)?.t);
    if (!options.allowStale && bars.length > 0 && ageHours > maxBarAgeHours) {
        throw new Error(`Stale market bars for ${symbol}: ${ageHours.toFixed(1)}h old (max ${maxBarAgeHours}h)`);
    }
    return bars;
}

/** Get historical bars for many symbols in batches (much faster for screeners). */
export async function getBarsForSymbols(
    symbols: string[],
    timeframe: string = "1Day",
    limit: number = 60
): Promise<Record<string, AlpacaBar[]>> {
    const normalized = Array.from(
        new Set(
            symbols
                .map((s) => s.trim().toUpperCase())
                .filter(Boolean)
        )
    );
    const barsBySymbol: Record<string, AlpacaBar[]> = {};
    if (normalized.length === 0) return barsBySymbol;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - Math.ceil(limit * 1.6));
    const start = startDate.toISOString().split("T")[0];
    const end = new Date().toISOString();
    const maxSymbolsPerRequest = 100;

    for (let i = 0; i < normalized.length; i += maxSymbolsPerRequest) {
        const chunk = normalized.slice(i, i + maxSymbolsPerRequest);
        const symbolsParam = encodeURIComponent(chunk.join(","));
        const requestLimit = Math.min(10000, Math.max(1000, (limit * chunk.length) + 100));
        const url = `/v2/stocks/bars?symbols=${symbolsParam}&timeframe=${timeframe}&start=${start}&end=${encodeURIComponent(end)}&limit=${requestLimit}&feed=iex&sort=asc`;
        const data = await alpacaFetch<{ bars?: Record<string, AlpacaBar[]> }>(url);
        const payload = data.bars ?? {};
        for (const symbol of chunk) {
            barsBySymbol[symbol] = payload[symbol] ?? [];
        }
    }

    return barsBySymbol;
}

/** Get the latest trade for a symbol */
export async function getLatestTrade(symbol: string): Promise<AlpacaLatestTrade> {
    const url = `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=iex`;
    const data = await alpacaFetch<{ trade: AlpacaLatestTrade }>(url);
    return data.trade;
}

/** Quick connectivity check — returns account status */
export async function checkConnection(): Promise<string> {
    try {
        const account = await getAccount();
        return `✅ Connected to Alpaca Paper Trading | Equity: $${account.equity} | Buying Power: $${account.buying_power}`;
    } catch (err: any) {
        return `❌ Alpaca connection failed: ${err.message}`;
    }
}
