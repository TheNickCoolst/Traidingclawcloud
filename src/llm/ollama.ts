import { config } from "../config.js";
import type { IProvider, ChatOptions, ChatCompletionMessage } from "./providers.js";

// Note: This implements a lightweight adapter pointing to Ollama's Chat API
// It transforms Ollama JSON output to match OpenAI's ChatCompletionMessage format.
export class OllamaProvider implements IProvider {
    id = "ollama";

    async complete(options: ChatOptions): Promise<ChatCompletionMessage> {
        if (!config.ollamaHost) {
            throw new Error(`OllamaProvider: OLLAMA_HOST is not configured.`);
        }

        const model = options.modelOverride ?? "llama3.2"; // Default fallback assumption for local ollama
        const maxTokens = options.maxTokens && Number.isFinite(options.maxTokens)
            ? Math.max(32, Math.floor(options.maxTokens))
            : undefined;
        const ollamaMessages = options.messages.map(m => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        }));

        if (options.systemPrompt) {
            ollamaMessages.unshift({ role: "system", content: options.systemPrompt });
        }

        // Basic thinking proxy
        if (options.thinking && options.thinking !== "off") {
            const extraPrompt = `[SYSTEM INSTRUCTION: Please provide a ${options.thinking}-level deeply reasoned output before answering. Map out your thoughts clearly.]`;
            if (options.systemPrompt) {
                ollamaMessages[0].content = options.systemPrompt + "\n" + extraPrompt;
            } else {
                ollamaMessages.unshift({ role: "system", content: extraPrompt });
            }
        }

        const payload = {
            model,
            messages: ollamaMessages,
            stream: false,
            // Ollama supports raw tools since recently, but mapping complex OpenAI schema is fragile.
            // For resilience on local smaller models, we pass tools as is (if supported by installed Ollama version)
            tools: options.tools,
            options: maxTokens ? { num_predict: maxTokens } : undefined,
        };

        const res = await fetch(`${config.ollamaHost}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`OllamaProvider Error (${res.status}): ${errBody}`);
        }

        const data = await res.json();

        // Optional: log Ollama token usage
        if (data.prompt_eval_count !== undefined && data.eval_count !== undefined) {
            import("../db.js").then(({ logTokenUsage }) => {
                logTokenUsage(
                    "ollama",
                    model,
                    data.prompt_eval_count,
                    data.eval_count,
                    data.prompt_eval_count + data.eval_count
                );
            }).catch(err => console.error("Failed to load db for token logging", err));
        }

        // Shape back into OpenAI format
        return {
            role: "assistant",
            content: data.message?.content || null,
            refusal: null,
            tool_calls: data.message.tool_calls?.map((tc: any, index: number) => ({
                id: tc.function?.name + "_" + index,
                type: "function",
                function: {
                    name: tc.function?.name,
                    arguments: JSON.stringify(tc.function?.arguments || {})
                }
            })) || undefined
        };
    }
}
