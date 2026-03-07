import { chat } from "../llm.js";

/**
 * Heuristics to analyze the final agent output and inject helpful suggestions.
 */
export async function injectSmartRecommendations(userText: string, agentReply: string): Promise<string> {
    try {
        // Only run suggestions aggressively if the agent's reply is short or implies an end-of-thought
        if (agentReply.length > 500) {
            return agentReply; // Too long, don't bloat it
        }

        const prompt = `You are a background analyzer for TradingClaw.
The user said: "${userText}"
The assistant replied: "${agentReply}"

Based on the assistant's capabilities (Web Search, File OS, CLI Shell, MCP tools, Knowledge Graph mapping, scheduling), suggest EXACTLY ONE highly-relevant, actionable next step the user could ask the assistant to do.
Format your response exactly like this:
💡 *Suggestion: [Your suggestion here]*

If no obvious next step exists, reply exactly with: NONE`;

        const response = await chat({
            messages: [{ role: "system", content: prompt }],
            // Force cheapest/fastest model for trailing suggestions to prevent UX latency
            modelOverride: "google/gemini-2.5-flash",
        });

        const textResult = response.content?.trim();

        if (textResult && textResult !== "NONE" && textResult.startsWith("💡")) {
            return `${agentReply}\n\n${textResult}`;
        }

        return agentReply;
    } catch (err: any) {
        console.error(`⚠️ Failed to generate smart recommendation: ${err.message || "Unknown error"}`);
        return agentReply;
    }
}
