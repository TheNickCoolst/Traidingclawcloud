import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import fs from "fs";
import { config } from "./config.js";

interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

interface McpConfig {
    mcpServers: Record<string, McpServerConfig>;
}

// Map serverName -> connected Client instance
const clients = new Map<string, Client>();

/**
 * Initialize all MCP servers defined in the generic config file.
 */
export async function connectMcpServers(): Promise<void> {
    const configPath = config.mcpServersConfigPath;
    if (!configPath || !fs.existsSync(configPath)) {
        console.log(`ℹ️  No MCP servers config found at ${configPath || ".env var empty"}`);
        return;
    }

    try {
        const fileContent = fs.readFileSync(configPath, "utf-8");
        const mcpConfig: McpConfig = JSON.parse(fileContent);

        for (const [serverName, serverCfg] of Object.entries(mcpConfig.mcpServers)) {
            console.log(`🔌 Connecting to MCP server: ${serverName}...`);

            const transport = new StdioClientTransport({
                command: serverCfg.command,
                args: serverCfg.args || [],
                env: {
                    ...(process.env as Record<string, string>), // Inherit base env
                    ...(serverCfg.env || {}),
                },
            });

            const client = new Client(
                { name: "TradingClaw", version: "1.0.0" },
                { capabilities: {} }
            );

            await client.connect(transport);
            clients.set(serverName, client);
            console.log(`✅ Connected to MCP server: ${serverName}`);
        }
    } catch (err) {
        console.error("❌ Failed to initialize MCP servers:", err);
    }
}

/**
 * Retrieve tools from all connected MCP servers and format them
 * for the OpenAI API (ChatCompletionTool).
 * We prefix names to identify which server they belong to later.
 */
export async function getMcpToolDefinitions(): Promise<ChatCompletionTool[]> {
    const allTools: ChatCompletionTool[] = [];

    for (const [serverName, client] of clients.entries()) {
        try {
            const response = await client.listTools();
            for (const mcpTool of response.tools) {
                // Prefix name to ensure uniqueness and routing: "mcp__serverName__toolName"
                const safeServerName = serverName.replace(/[^a-zA-Z0-9_-]/g, "");
                const routedName = `mcp__${safeServerName}__${mcpTool.name}`;

                allTools.push({
                    type: "function",
                    function: {
                        name: routedName,
                        description: `[from ${serverName}] ${mcpTool.description || ""}`,
                        parameters: mcpTool.inputSchema as Record<string, unknown>,
                    },
                });
            }
        } catch (err) {
            console.error(`❌ Failed to fetch tools from MCP server ${serverName}:`, err);
        }
    }

    return allTools;
}

/**
 * Execute a dynamically loaded MCP tool by its routed name.
 */
export async function executeMcpTool(
    routedName: string,
    args: Record<string, unknown>
): Promise<string> {
    // Parse back "mcp__serverName__toolName"
    const prefixMatch = routedName.match(/^mcp__([a-zA-Z0-9_-]+)__(.+)$/);
    if (!prefixMatch) {
        throw new Error(`Invalid MCP tool routed name: ${routedName}`);
    }

    const serverName = prefixMatch[1];
    const actualToolName = prefixMatch[2];

    const client = clients.get(serverName);
    if (!client) {
        throw new Error(`MCP client not found or disconnected: ${serverName}`);
    }

    try {
        const result = await client.callTool({
            name: actualToolName,
            arguments: args,
        });

        // Format the MCP result payload
        const contentArr = result.content as Array<{ type: string; text?: string }>;
        const textContents = contentArr
            .filter((c) => c.type === "text")
            .map((c) => c.text || JSON.stringify(c))
            .join("\n");

        return textContents || "Tool executed successfully (no text output).";
    } catch (err: any) {
        return `MCP Tool Error inside "${routedName}": ${err.message || String(err)}`;
    }
}
