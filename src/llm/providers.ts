import type {
    ChatCompletionMessageParam,
    ChatCompletionTool,
    ChatCompletionMessage,
} from "openai/resources/chat/completions.js";

export type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionMessage };

export interface ChatOptions {
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
    systemPrompt?: string;
    /** Level of thinking: "off" | "low" | "medium" | "high" */
    thinking?: string;
    /** Specific model override for this request */
    modelOverride?: string;
    /** Max output tokens for this request */
    maxTokens?: number;
}

export interface IProvider {
    /** unique ID like 'openrouter' or 'ollama' */
    id: string;
    /** Run a completion. Should throw on failure so failover can catch. */
    complete(options: ChatOptions): Promise<ChatCompletionMessage>;
}
