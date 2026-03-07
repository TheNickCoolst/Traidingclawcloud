import { EventEmitter } from "events";
import { config } from "../config.js";
import { chat } from "../llm.js";
import { getToolDefinitions, executeTool } from "../tools/index.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export interface ToolCallEvent {
    name: string;
    arguments: Record<string, unknown>;
}

export interface ToolResultEvent {
    name: string;
    result: string;
}

interface RunOptions {
    allowedToolNames?: string[];
    modelOverride?: string;
    maxTokens?: number;
}

export declare interface AgentLoop {
    on(event: 'tool_call', listener: (data: ToolCallEvent) => void): this;
    on(event: 'tool_result', listener: (data: ToolResultEvent) => void): this;
    on(event: 'final_response', listener: (response: string) => void): this;
    on(event: 'iteration_limit_reached', listener: () => void): this;
}

export class AgentLoop extends EventEmitter {
    private maxIterations: number;
    private lowBudgetWarningSent = false;

    constructor(maxIter?: number) {
        super();
        this.maxIterations = maxIter ?? config.maxToolIterations;
    }

    /**
     * Run the agentic tool loop until a final text response is produced
     * or the maximum iteration limit is reached.
     */
    async run(
        history: ChatCompletionMessageParam[],
        systemPrompt: string,
        thinkingPreference: string = "off",
        options?: RunOptions
    ): Promise<string> {
        let iterations = 0;
        let emptyResponseCount = 0;
        this.lowBudgetWarningSent = false;
        const allTools = await getToolDefinitions();
        const allowedToolSet = options?.allowedToolNames ? new Set(options.allowedToolNames) : null;
        const tools = allowedToolSet
            ? allTools.filter((tool) => tool.type === "function" && allowedToolSet.has(tool.function.name))
            : allTools;

        while (iterations < this.maxIterations) {
            const remainingIterations = this.maxIterations - iterations;
            if (!this.lowBudgetWarningSent && remainingIterations <= 2) {
                history.push({
                    role: "user",
                    content: "Iteration budget is nearly exhausted. Use only critical final tool calls now. If you already have enough information, stop calling tools and return the final summary in this reply.",
                });
                this.lowBudgetWarningSent = true;
            }

            iterations++;

            const message = await chat({
                messages: history,
                tools: tools.length > 0 ? tools : undefined,
                systemPrompt,
                thinking: thinkingPreference,
                modelOverride: options?.modelOverride,
                maxTokens: options?.maxTokens,
            });

            // Check if the LLM wants to call tools
            if (message.tool_calls && message.tool_calls.length > 0) {
                // Add assistant message with tool calls to history
                history.push({
                    role: "assistant",
                    content: message.content ?? null,
                    tool_calls: message.tool_calls,
                });

                // Execute each tool call and add results
                for (const toolCall of message.tool_calls) {
                    const fnName = toolCall.function.name;
                    let args: Record<string, unknown> = {};
                    try {
                        args = JSON.parse(toolCall.function.arguments || "{}");
                    } catch {
                        // If args parsing fails, pass empty object
                    }

                    this.emit('tool_call', { name: fnName, arguments: args });

                    try {
                        const output = await executeTool(fnName, args);
                        this.emit('tool_result', { name: fnName, result: output });

                        history.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: output,
                        });
                    } catch (err: any) {
                        const errorMsg = `Error executing tool: ${err.message}`;
                        this.emit('tool_result', { name: fnName, result: errorMsg });

                        history.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: errorMsg,
                        });
                    }
                }

                continue; // Loop back to get LLM's response with tool results
            }

            // LLM returned a final text response (no tool calls)
            const text = message.content?.trim() ?? "";
            if (!text) {
                emptyResponseCount++;

                if (emptyResponseCount >= 3) {
                    const fallback = "⚠️ Model returned empty output repeatedly after tool execution. Final summary unavailable.";
                    history.push({ role: "assistant", content: fallback });
                    this.emit('final_response', fallback);
                    return fallback;
                }

                history.push({
                    role: "user",
                    content: "Your previous reply was empty. You must either call tools or return a short final summary now.",
                });
                continue;
            }

            emptyResponseCount = 0;
            history.push({ role: "assistant", content: text });

            this.emit('final_response', text);
            return text;
        }

        this.emit('iteration_limit_reached');
        return `⚠️ Reached maximum tool iterations (${this.maxIterations}). The agent could not find a suitable outcome within the limit.`;
    }
}
