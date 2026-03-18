import OpenAI from "openai";
import { config } from "../config.js";
import type { IProvider, ChatOptions, ChatCompletionMessage } from "./providers.js";

const MINIMAX_BASE_URL = "https://api.minimax.chat/v1";
const DEFAULT_MINIMAX_MODEL = "MiniMax-Text-01";

export class MiniMaxProvider implements IProvider {
    id = "minimax";
    private client: OpenAI;

    constructor() {
        if (!config.minimaxApiKey) {
            throw new Error("[MiniMax] MINIMAX_API_KEY is not configured.");
        }
        this.client = new OpenAI({
            baseURL: MINIMAX_BASE_URL,
            apiKey: config.minimaxApiKey,
        });
        console.log("[MiniMax] Provider initialized");
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

        const model = options.modelOverride ?? config.minimaxModel ?? DEFAULT_MINIMAX_MODEL;
        const maxTokens = Math.max(32, Math.floor(options.maxTokens ?? 4096));

        const response = await this.client.chat.completions.create({
            model,
            messages,
            tools: options.tools && options.tools.length > 0 ? options.tools : undefined,
            max_tokens: maxTokens,
        });

        const choice = response.choices[0];
        if (!choice) {
            throw new Error(`MiniMax: No response from model ${model}`);
        }

        if (response.usage) {
            import("../db.js").then(({ logTokenUsage }) => {
                logTokenUsage(
                    "minimax",
                    model,
                    response.usage!.prompt_tokens,
                    response.usage!.completion_tokens,
                    response.usage!.total_tokens,
                    { runtimeRole: config.runtimeRole }
                );
            }).catch((err) => console.error("Failed to load db for token logging", err));
        }

        return choice.message;
    }
}
