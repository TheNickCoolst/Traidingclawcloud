import OpenAI from "openai";
import { config } from "../config.js";
import type { IProvider, ChatOptions, ChatCompletionMessage } from "./providers.js";

export class OpenRouterProvider implements IProvider {
    id = "openrouter";

    /** All available API keys — rotates through on failure */
    private apiKeys: string[];
    private currentKeyIndex = 0;
    private clients: Map<number, OpenAI> = new Map();

    constructor() {
        // Parse comma-separated keys from config
        this.apiKeys = config.openrouterApiKey
            .split(",")
            .map(k => k.trim())
            .filter(Boolean);

        console.log(`🔑 [OpenRouter] Loaded ${this.apiKeys.length} API key(s)`);
    }

    /** Get or create an OpenAI client for the given key index */
    private getClient(keyIndex: number): OpenAI {
        if (!this.clients.has(keyIndex)) {
            this.clients.set(keyIndex, new OpenAI({
                baseURL: "https://openrouter.ai/api/v1",
                apiKey: this.apiKeys[keyIndex],
                defaultHeaders: {
                    "HTTP-Referer": "https://tradingclaw.local",
                    "X-Title": "TradingClaw",
                },
            }));
        }
        return this.clients.get(keyIndex)!;
    }

    /** Rotate to the next API key */
    private rotateKey(): void {
        const oldIndex = this.currentKeyIndex;
        this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
        console.log(`🔄 [OpenRouter] Rotated API key: #${oldIndex + 1} → #${this.currentKeyIndex + 1}`);
    }

    async complete(options: ChatOptions): Promise<ChatCompletionMessage> {
        const messages = [...options.messages];

        // Add system prompt as first message
        if (options.systemPrompt) {
            messages.unshift({ role: "system", content: options.systemPrompt });
        }

        // Apply thinking mapping prefix if explicitly requested
        if (options.thinking && options.thinking !== "off") {
            const extraPrompt = `[SYSTEM INSTRUCTION: Please provide a ${options.thinking}-level deeply reasoned output before answering. Map out your thoughts clearly.]`;
            if (options.systemPrompt) {
                messages[0] = { role: "system", content: options.systemPrompt + "\n" + extraPrompt };
            } else {
                messages.unshift({ role: "system", content: extraPrompt });
            }
        }

        const model = options.modelOverride ?? config.model;
        const maxTokens = Math.max(32, Math.floor(options.maxTokens ?? 4096));

        // Try each API key starting from current, rotating on failure
        let lastError: any;
        for (let attempt = 0; attempt < this.apiKeys.length; attempt++) {
            const keyIndex = (this.currentKeyIndex + attempt) % this.apiKeys.length;
            const client = this.getClient(keyIndex);

            try {
                const response = await client.chat.completions.create({
                    model,
                    messages,
                    tools: options.tools && options.tools.length > 0 ? options.tools : undefined,
                    max_tokens: maxTokens,
                });

                const choice = response.choices[0];
                if (!choice) {
                    throw new Error(`OpenRouter: No response from model ${model}`);
                }

                // Log token usage
                if (response.usage) {
                    import("../db.js").then(({ logTokenUsage }) => {
                        logTokenUsage(
                            "openrouter",
                            model,
                            response.usage!.prompt_tokens,
                            response.usage!.completion_tokens,
                            response.usage!.total_tokens
                        );
                    }).catch(err => console.error("Failed to load db for token logging", err));
                }

                // Success — update current key index for next call (round-robin)
                this.currentKeyIndex = (keyIndex + 1) % this.apiKeys.length;
                return choice.message;

            } catch (err: any) {
                const status = err?.status || err?.response?.status || "";
                console.warn(`⚠️ [OpenRouter] Key #${keyIndex + 1} failed (${status}): ${err.message}`);
                lastError = err;

                // Only rotate on rate limit / auth / server errors
                if (attempt < this.apiKeys.length - 1) {
                    console.log(`🔄 [OpenRouter] Trying next key...`);
                }
            }
        }

        throw new Error(`OpenRouter: All ${this.apiKeys.length} API keys failed. Last error: ${lastError?.message}`);
    }
}
