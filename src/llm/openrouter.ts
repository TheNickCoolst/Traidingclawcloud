import OpenAI from "openai";
import { config } from "../config.js";
import type { IProvider, ChatOptions, ChatCompletionMessage } from "./providers.js";

export class OpenRouterProvider implements IProvider {
    id = "openrouter";

    private apiKeys: string[];
    private clients: Map<number, OpenAI> = new Map();
    private keyUsageTotals: number[];

    constructor() {
        this.apiKeys = config.openrouterApiKey
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean);
        this.keyUsageTotals = new Array(this.apiKeys.length).fill(0);

        console.log(`[OpenRouter] Loaded ${this.apiKeys.length} API key(s)`);
    }

    private getClient(keyIndex: number): OpenAI {
        if (!this.clients.has(keyIndex)) {
            this.clients.set(keyIndex, new OpenAI({
                baseURL: "https://openrouter.ai/api/v1",
                apiKey: this.apiKeys[keyIndex],
                defaultHeaders: {
                    "HTTP-Referer": config.openrouterAppReferer,
                    "X-Title": config.openrouterAppTitle,
                },
            }));
        }
        return this.clients.get(keyIndex)!;
    }

    private getRolePriorityOffset(total: number): number {
        if (total <= 1) return 0;
        if (config.runtimeRole === "ultra") return 0;
        if (config.runtimeRole === "light") return Math.min(1, total - 1);
        return Math.min(2, total - 1);
    }

    // ultra: least-used first, then light, then main/all.
    private buildKeyAttemptOrder(): number[] {
        const indices = this.apiKeys.map((_k, i) => i);
        indices.sort((a, b) => {
            const delta = this.keyUsageTotals[a] - this.keyUsageTotals[b];
            if (delta !== 0) return delta;
            return a - b;
        });

        const offset = this.getRolePriorityOffset(indices.length);
        if (offset <= 0) return indices;
        return indices.slice(offset).concat(indices.slice(0, offset));
    }

    private getCycleModeTag(): string {
        if (config.runtimeRole === "ultra") return "ultra_light";
        if (config.runtimeRole === "light") return "light";
        return "main";
    }

    async complete(options: ChatOptions): Promise<ChatCompletionMessage> {
        const messages = [...options.messages];

        if (options.systemPrompt) {
            messages.unshift({ role: "system", content: options.systemPrompt });
        }

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
        const attemptOrder = this.buildKeyAttemptOrder();

        let lastError: any;
        for (let attempt = 0; attempt < attemptOrder.length; attempt++) {
            const keyIndex = attemptOrder[attempt];
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

                if (response.usage) {
                    this.keyUsageTotals[keyIndex] += response.usage.total_tokens;
                    import("../db.js").then(({ logTokenUsage }) => {
                        logTokenUsage(
                            "openrouter",
                            model,
                            response.usage!.prompt_tokens,
                            response.usage!.completion_tokens,
                            response.usage!.total_tokens,
                            {
                                apiKeySlot: keyIndex + 1,
                                runtimeRole: config.runtimeRole,
                                cycleMode: this.getCycleModeTag(),
                            }
                        );
                    }).catch((err) => console.error("Failed to load db for token logging", err));
                }

                return choice.message;
            } catch (err: any) {
                const status = err?.status || err?.response?.status || "";
                console.warn(`[OpenRouter] Key #${keyIndex + 1} failed (${status}): ${err.message}`);
                lastError = err;

                if (attempt < attemptOrder.length - 1) {
                    console.log("[OpenRouter] Trying next key...");
                }
            }
        }

        throw new Error(`OpenRouter: All ${this.apiKeys.length} API keys failed. Last error: ${lastError?.message}`);
    }
}
