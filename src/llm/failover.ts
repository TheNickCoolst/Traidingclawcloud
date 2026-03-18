import { config } from "../config.js";
import type { IProvider, ChatOptions, ChatCompletionMessage } from "./providers.js";
import { OpenRouterProvider } from "./openrouter.js";
import { OllamaProvider } from "./ollama.js";
import { MiniMaxProvider } from "./minimax.js";

// Lazy provider registry so failed duplicate startup attempts do not eagerly
// initialize heavy providers and spam startup logs.
const availableProviders: Map<string, IProvider> = new Map();

function getProvider(providerId: string): IProvider | null {
    const existing = availableProviders.get(providerId);
    if (existing) return existing;

    let provider: IProvider | null = null;
    if (providerId === "openrouter") provider = new OpenRouterProvider();
    if (providerId === "ollama") provider = new OllamaProvider();
    if (providerId === "minimax") provider = new MiniMaxProvider();

    if (!provider) return null;
    availableProviders.set(providerId, provider);
    return provider;
}

export class FailoverChain {
    private chain: string[];

    constructor(chainConfig: string[]) {
        this.chain = chainConfig;
    }

    async execute(options: ChatOptions): Promise<ChatCompletionMessage> {
        if (this.chain.length === 0) {
            throw new Error("FailoverChain strategy aborted: PROVIDER_CHAIN is empty.");
        }

        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 2 * 60 * 1000; // 2 minutes

        let lastError: any;

        for (let retry = 0; retry <= MAX_RETRIES; retry++) {
            if (retry > 0) {
                console.log(`🔄 [Failover] All providers failed — retry ${retry}/${MAX_RETRIES} in 2 minutes...`);
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                console.log(`🔄 [Failover] Retry ${retry}/${MAX_RETRIES} — sweeping all providers again...`);
            }

            // Iterate through each provider in the fallback stack
            for (const providerId of this.chain) {
                const provider = getProvider(providerId);

                if (!provider) {
                    console.warn(`[Failover] Skipping unknown provider: '${providerId}'`);
                    continue;
                }

                try {
                    // Return immediately if it succeeds
                    const result = await provider.complete(options);
                    return result;
                } catch (err: any) {
                    console.error(`[Failover] Provider '${providerId}' failed: ${err.message}`);
                    lastError = err;
                }
            }
        }

        throw new Error(`[Failover Orchestrator] All providers failed after ${MAX_RETRIES} retries. Last error: ${lastError?.message || lastError}`);
    }
}

// Instantiate the globally shared orchestrator utilizing .env config
export const failoverOrchestrator = new FailoverChain(config.providerChain);
