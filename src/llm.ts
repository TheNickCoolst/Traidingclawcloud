import { failoverOrchestrator } from "./llm/failover.js";
import type { ChatOptions } from "./llm/providers.js";
import type {
    ChatCompletionMessageParam,
    ChatCompletionTool,
    ChatCompletionMessage,
} from "openai/resources/chat/completions.js";

// Re-export common types
export type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionMessage };

/**
 * Send a conversation to the LLM via the failover orchestrator and get a response.
 */
export async function chat(options: ChatOptions): Promise<ChatCompletionMessage> {
    return failoverOrchestrator.execute(options);
}
