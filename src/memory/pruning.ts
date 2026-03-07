import { chat } from "../llm.js";
import { saveSession, getSession } from "../db.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

const TOKEN_ESTIMATE_RATIO = 4.0; // Approx 4 characters per token
const CONTEXT_WARNING_THRESHOLD = 20000; // Trigger pruning if token estimate goes beyond this

function estimateTokens(messages: ChatCompletionMessageParam[]): number {
    let charCount = 0;
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            charCount += msg.content.length;
        } else if (Array.isArray(msg.content)) {
            charCount += JSON.stringify(msg.content).length; // rough estimate for multimodal/complex text
        }
    }
    return Math.floor(charCount / TOKEN_ESTIMATE_RATIO);
}

/**
 * Iterates over the history, slices the oldest 50%, summarizes them using a lightweight LLM call,
 * and substitutes them with a dense single memory node.
 */
export async function pruneContext(sessionId: string): Promise<boolean> {
    const session = getSession(sessionId);
    if (!session) return false;

    let history: ChatCompletionMessageParam[] = [];
    try {
        history = JSON.parse(session.messages_json);
    } catch {
        return false;
    }

    if (history.length <= 2) return false; // Too short to effectively summarize

    // Slice older 50%
    const cutoff = Math.floor(history.length / 2);
    const oldestMessages = history.slice(0, cutoff);
    const recentMessages = history.slice(cutoff);

    // Ask LLM to summarize
    const summaryPrompt = "You are an AI tasked with context pruning. Please read the following chat history chunks and summarize the crucial facts, technical context, and ongoing threads compactly into one highly dense paragraph. Do not omit important data. Exclude polite filler.";

    try {
        const result = await chat({
            systemPrompt: summaryPrompt,
            messages: [{
                role: "user",
                content: JSON.stringify(oldestMessages.map(m => `[${m.role}]: ${m.content}`))
            }]
        });

        const newPrunedHistory: ChatCompletionMessageParam[] = [
            {
                role: "assistant",
                content: `[PRUNED CONTEXT SUMMARY]: ${result.content}`
            },
            ...recentMessages
        ];

        saveSession(sessionId, session.channel, JSON.stringify(newPrunedHistory), session.summary);
        return true;
    } catch (err) {
        console.error("❌ Context pruning failed:", err);
        return false;
    }
}

/**
 * Called periodically during the agentic loop to ensure context window remains safe.
 */
export async function autoPruneIfNeeded(sessionId: string, history: ChatCompletionMessageParam[]) {
    const estimated = estimateTokens(history);
    if (estimated > CONTEXT_WARNING_THRESHOLD) {
        console.log(`🧹 Token threshold reached (${estimated} > ${CONTEXT_WARNING_THRESHOLD}). Auto-pruning context...`);

        // We defer to the explicit pruning execution which reads/writes directly to the DB
        // But to keep the current running loop correct, if it triggered mid-loop, we notify.
        // In practice for TrainingClaw, history is flushed/read at the start/end of handleMessage.
        return true;
    }
    return false;
}
