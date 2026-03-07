import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { getMcpToolDefinitions, executeMcpTool } from "../mcp.js";
import { registerTavilyTool } from "./tavily.js";

/** Handler function signature for tools */
export type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

/** Registry entry: definition + handler */
interface ToolEntry {
    definition: ChatCompletionTool;
    handler: ToolHandler;
}

const registry = new Map<string, ToolEntry>();

/** Register a tool with its OpenAI-format definition and handler */
export function registerTool(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    handler: ToolHandler
): void {
    const definition: ChatCompletionTool = {
        type: "function",
        function: {
            name,
            description,
            parameters,
        },
    };
    registry.set(name, { definition, handler });
}

/** Get all tool definitions for the OpenAI API (Local + MCP) */
export async function getToolDefinitions(): Promise<ChatCompletionTool[]> {
    // Ensure all native tools are registered if not already
    registerTavilyTool();

    const localTools = Array.from(registry.values()).map((e) => e.definition);
    const mcpTools = await getMcpToolDefinitions();
    return [...localTools, ...mcpTools];
}

/** Execute a tool by name, returns the result string */
export async function executeTool(
    name: string,
    input: Record<string, unknown>
): Promise<string> {
    // Route MCP tools to the MCP manager
    if (name.startsWith("mcp__")) {
        return await executeMcpTool(name, input);
    }

    const entry = registry.get(name);
    if (!entry) {
        return `Error: Unknown tool "${name}"`;
    }
    try {
        return await entry.handler(input);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error executing tool "${name}": ${message}`;
    }
}
