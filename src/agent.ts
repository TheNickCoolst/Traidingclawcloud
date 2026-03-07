import { config } from "./config.js";
import { chat } from "./llm.js";
import { getToolDefinitions, executeTool } from "./tools/index.js";
import { getSession, saveSession, deleteSession } from "./db.js";
import { AgentLoop, ToolCallEvent, ToolResultEvent } from "./agent/loop.js";
import { getThinkingLevel } from "./llm/thinking.js";
import { autoPruneIfNeeded, pruneContext } from "./memory/pruning.js";
import { injectSmartRecommendations } from "./proactive/recommendations.js";
import { pluginHooks } from "./architecture/plugins.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import * as alpaca from "./trading/alpaca.js";

// -- Register all tools (side-effect imports) --
import "./tools/get-current-time.js";
import "./tools/memory.js";
import "./tools/shell.js";
import "./tools/fs.js";
import "./tools/search.js";
import "./tools/browser.js";
import "./trading/tools.js"; // Alpaca trading tools

// -- Architecture integrations --
import "./architecture/swarm.js";
import "./architecture/workflows.js";

const SYSTEM_PROMPT = `You are TradingClaw — an autonomous stock trading bot running on Alpaca paper trading.

MISSION: Generate profit through intelligent stock trading with light-to-medium risk.

CORE RULES:
- Paper trading only — no real money at risk
- Standard trading only — NO leverage, NO margin, NO short selling, NO options
- Buy stocks you believe will increase in value based on research
- Never risk more than 10% of portfolio on one trade
- Prefer liquid, well-known stocks (large/mid cap)

AVAILABLE TOOLS:
- get_account: Check buying power, equity, portfolio value
- get_positions: View all open positions with P/L
- place_order: Buy or sell stocks (market/limit orders)
- cancel_order: Cancel pending orders
- get_orders: List open/recent orders
- get_market_data: Get historical price bars for analysis
- get_latest_price: Check current stock price
- web_search: Search for market news, trends, and investment opportunities
- store_memory: Save important trading insights
- search_memory: Recall past trading knowledge

RISK MANAGEMENT:
- Diversify across 3-5+ different stocks
- Max 20% of buying power per single trade
- Cut losses at -5%, take profits at +10-15%
- Prefer stocks with positive momentum

When a user asks about your trading, provide clear summaries.
When triggered for a trading cycle, be decisive and execute trades.
`;


interface CapturedToolResult {
    name: string;
    result: string;
}

interface ParsedExecutionAck {
    ok: boolean;
    side?: "BUY" | "SELL";
    qty?: string;
    symbol?: string;
    orderId?: string;
    status?: string;
    type?: string;
    reason?: string;
}

function firstLine(text: string): string {
    return text
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean) || "";
}

function parsePlaceOrderResult(result: string): ParsedExecutionAck {
    const text = result || "";
    const ok = text.startsWith("OK:") || text.startsWith("✅");
    if (!ok) {
        return { ok: false, reason: firstLine(text) };
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

function parseCancelResult(result: string): { ok: boolean; orderId?: string; reason?: string } {
    const text = result || "";
    const ok = text.startsWith("✅") || text.startsWith("OK:");
    if (!ok) {
        return { ok: false, reason: firstLine(text) };
    }
    const idMatch = text.match(/Order\s+([a-zA-Z0-9-]+)\s+cancelled/i);
    return { ok: true, orderId: idMatch?.[1] };
}

async function buildVerifiedExecutionReply(toolResults: CapturedToolResult[]): Promise<string | null> {
    const placeAttempts = toolResults.filter((e) => e.name === "place_order");
    const cancelAttempts = toolResults.filter((e) => e.name === "cancel_order");
    if (placeAttempts.length === 0 && cancelAttempts.length === 0) {
        return null;
    }

    const placeAcks = placeAttempts.map((e) => parsePlaceOrderResult(e.result));
    const cancelAcks = cancelAttempts.map((e) => parseCancelResult(e.result));
    const accepted = placeAcks.filter((a) => a.ok);
    const rejected = placeAcks.filter((a) => !a.ok);
    const cancelOk = cancelAcks.filter((a) => a.ok).length;
    const cancelFail = cancelAcks.filter((a) => !a.ok).length;

    let openOrders: alpaca.AlpacaOrder[] = [];
    let allOrders: alpaca.AlpacaOrder[] = [];
    let positions: alpaca.AlpacaPosition[] = [];
    let account: alpaca.AlpacaAccount | null = null;
    try {
        [openOrders, allOrders, positions, account] = await Promise.all([
            alpaca.getOrders("open"),
            alpaca.getOrders("all"),
            alpaca.getPositions(),
            alpaca.getAccount(),
        ]);
    } catch {
        // Keep best-effort report even if refresh fails.
    }

    const openIds = new Set(openOrders.map((o) => o.id));
    const allIds = new Set(allOrders.map((o) => o.id));

    const acceptedLines = accepted.length > 0
        ? accepted.slice(0, 8).map((ack) => {
            const id = ack.orderId ?? "missing-id";
            const verification = ack.orderId
                ? (openIds.has(ack.orderId)
                    ? "OPEN"
                    : allIds.has(ack.orderId)
                        ? "CONFIRMED_NOT_OPEN"
                        : "UNCONFIRMED")
                : "UNCONFIRMED";
            return `- ${ack.side ?? "?"} ${ack.qty ?? "?"}x ${ack.symbol ?? "?"} | ${ack.type ?? "unknown"} | status ${ack.status ?? "unknown"} | id ${id} | verify ${verification}`;
        })
        : ["- none"];

    const rejectedLines = rejected.length > 0
        ? rejected.slice(0, 6).map((ack) => `- ${ack.reason || "unknown rejection"}`)
        : ["- none"];

    const positionPreview = positions.length > 0
        ? positions
            .slice(0, 8)
            .map((p) => `${p.symbol} ${p.qty}x (${(Number(p.unrealized_plpc || 0) * 100).toFixed(2)}%)`)
            .join(" | ")
        : "none";

    const accountLine = account
        ? `Equity $${Number(account.equity || 0).toFixed(2)} | Cash $${Number(account.cash || 0).toFixed(2)}`
        : "Account snapshot unavailable";

    return [
        `VERIFIED EXECUTION REPORT (broker-anchored):`,
        `place_order attempts: ${placeAttempts.length} | accepted: ${accepted.length} | rejected: ${rejected.length}`,
        `cancel_order attempts: ${cancelAttempts.length} | success: ${cancelOk} | failed: ${cancelFail}`,
        `Accepted orders:`,
        ...acceptedLines,
        `Rejected/blocked order attempts:`,
        ...rejectedLines,
        `Open orders now: ${openOrders.length}`,
        `Positions now: ${positions.length} | ${positionPreview}`,
        accountLine,
    ].join("\n");
}

const MAX_HISTORY = 50; // keep last N messages per chat

/**
 * Run the agentic tool loop for a single user message.
 * Returns the final text response from the LLM.
 */
export async function handleMessage(
    chatId: number,
    userText: string
): Promise<string> {
    const sessionId = `telegram_${chatId}`;

    // Get or create conversation history from DB
    let history: ChatCompletionMessageParam[] = [];
    const session = getSession(sessionId);
    if (session) {
        try {
            history = JSON.parse(session.messages_json);
        } catch (e) {
            console.error(`❌ Failed to parse session history for ${sessionId}:`, e);
        }
    }

    // Add user message
    let processedUserText = userText;

    // Apply Plugin Pre-processing Hooks
    const pluginCtx = { chatId, userId: 0, text: userText, metadata: {} };
    // Usually userId would be passed into handleMessage, but for now we default to 0 inside plugins or map it if we refactor.
    try {
        pluginHooks.emit("onMessageReceived", pluginCtx);
        if (pluginCtx.text !== userText) {
            console.log(`🔌 [Plugin] Text intercepted/modified by a plugin.`);
            processedUserText = pluginCtx.text;
        }
    } catch (err) {
        console.error("Plugin hook onMessageReceived failed:", err);
    }

    history.push({ role: "user", content: processedUserText });

    // Trim history if too long naturally without pruning (hard bound)
    if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
    }

    // Auto-prune if token length heavily exceeds limits
    const wasPruned = await autoPruneIfNeeded(sessionId, history);
    if (wasPruned) {
        await pruneContext(sessionId);
        // Reload history immediately after pruning so this loop gets the compressed view
        const prunedSession = getSession(sessionId);
        if (prunedSession) {
            try { history = JSON.parse(prunedSession.messages_json); } catch { }
        }
    }

    const loop = new AgentLoop();
    let finalOutput = "";
    const capturedToolResults: CapturedToolResult[] = [];

    loop.on('tool_call', ({ name, arguments: args }: ToolCallEvent) => {
        console.log(`  🔧 Tool call: ${name}(${JSON.stringify(args)})`);
    });

    loop.on('tool_result', ({ name, result }: ToolResultEvent) => {
        console.log(`  ✅ Result: ${result}`);
        capturedToolResults.push({ name, result });
    });

    try {
        const thinkingLevel = getThinkingLevel(sessionId);
        finalOutput = await loop.run(history, SYSTEM_PROMPT, thinkingLevel);

        // Asynchronously scan the final reply and append smart tool recommendations if appropriate
        finalOutput = await injectSmartRecommendations(userText, finalOutput);

        // Hard truth guard: for any execution attempt, only return broker-anchored confirmation.
        const verifiedExecutionReply = await buildVerifiedExecutionReply(capturedToolResults);
        if (verifiedExecutionReply) {
            finalOutput = verifiedExecutionReply;
            history.push({ role: "assistant", content: verifiedExecutionReply });
        }

    } catch (err: any) {
        if (err.message && err.message.includes("403 Key limit exceeded") || err.message.includes("All providers failed")) {
            console.warn("⚠️ API keys exhausted. User must add more credits.");
            finalOutput = "🛑 I am completely out of API credits or all keys have hit their rate limit. Please add new OpenRouter keys to my `.env` configuration to continue.";
        } else {
            console.error(`❌ AgentLoop execution error: ${err.message}`);
            finalOutput = "⚠️ Something went wrong executing the agent loop.";
        }
    }

    // Save session before returning
    saveSession(sessionId, "telegram", JSON.stringify(history));
    return finalOutput;
}

/** Clear conversation history for a chat */
export function clearHistory(chatId: number): void {
    const sessionId = `telegram_${chatId}`;
    deleteSession(sessionId);
}
