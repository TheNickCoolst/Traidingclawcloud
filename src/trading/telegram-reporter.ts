import { config } from "../config.js";
import { router } from "../channels/router.js";
import { getTokenUsageStats } from "../db.js";

export type FastCycleMode = "light" | "ultra_light";

function getAdminChatId(): number {
    return Number(config.allowedUserIds[0] || 0);
}

function compactText(text: string, maxLength: number): string {
    const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 3)}...`;
}

function firstLines(text: string, maxLines: number): string {
    return String(text ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, maxLines)
        .join("\n");
}

function n(v: number): string {
    return Number(v || 0).toLocaleString("en-US");
}

function buildTokenUsageSummary(): string {
    const s = getTokenUsageStats();
    return `TOKEN USAGE | 1h in:${n(s["1h_prompt"])} out:${n(s["1h_comp"])} req:${n(s["1h_req"])} | 24h in:${n(s["24h_prompt"])} out:${n(s["24h_comp"])} req:${n(s["24h_req"])} | 7d in:${n(s["7d_prompt"])} out:${n(s["7d_comp"])} req:${n(s["7d_req"])}`;
}

function buildTokenUsageSuffix(): string {
    if (!config.telegramNotifyTokenUsage) return "";
    return `\n\n${buildTokenUsageSummary()}`;
}

export function logTokenUsageSnapshot(context: string): void {
    console.log(`[Trading][Usage] ${context} | ${buildTokenUsageSummary()}`);
}

export async function notifyAdminTelegram(message: string): Promise<void> {
    if (!config.telegramBotToken) return;

    const adminId = getAdminChatId();
    if (!adminId) return;

    try {
        await router.send("telegram", {
            chatId: adminId,
            userId: adminId,
            text: message,
        });
        console.log(`[Trading][Telegram] Admin notification delivered (${message.length} chars).`);
    } catch (err: any) {
        console.error("[Trading][Telegram] Failed to notify admin:", err.message);
    }
}

export async function notifyCycleStart(label: string, context?: string): Promise<void> {
    if (!config.telegramNotifyCycleStarts) return;
    const body = context ? `\n${compactText(context, 900)}` : "";
    await notifyAdminTelegram(`START ${label}${body}`);
}

export async function notifyCycleResult(label: string, summary: string): Promise<void> {
    if (!config.telegramNotifyCycleResults) return;
    await notifyAdminTelegram(`${label}\n\n${summary}${buildTokenUsageSuffix()}`);
}

export async function notifyFastCycleResult(mode: FastCycleMode, summary: string): Promise<void> {
    const compact = firstLines(summary, 2);
    const looksLikeSkip = /\bSKIP\b/i.test(compact);
    if (looksLikeSkip && !config.telegramNotifyFastCycleSkips) {
        return;
    }

    const label = mode === "ultra_light" ? "ULTRA LIGHT UPDATE" : "LIGHT UPDATE";
    await notifyAdminTelegram(`${label}\n\n${compactText(compact, 1200)}${buildTokenUsageSuffix()}`);
}

export async function notifyTradeEvent(event: {
    symbol: string;
    side: string;
    qty: number;
    price: number | null;
    orderType: string;
    orderId: string | null;
    status: string;
    reasoning: string | null;
}): Promise<void> {
    if (!config.telegramNotifyTradeEvents) return;

    const priceLabel = event.price == null ? "MARKET" : `$${event.price}`;
    const lines = [
        "TRADE EVENT",
        `${String(event.side).toUpperCase()} ${event.qty}x ${event.symbol} @ ${priceLabel}`,
        `Type: ${event.orderType} | Status: ${event.status}`,
        `Order ID: ${event.orderId || "n/a"}`,
        `Reason: ${compactText(event.reasoning || "n/a", 700)}`,
    ];
    await notifyAdminTelegram(`${lines.join("\n")}${buildTokenUsageSuffix()}`);
}
