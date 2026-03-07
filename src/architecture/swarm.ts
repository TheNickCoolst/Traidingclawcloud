import { registerTool } from "../tools/index.js";
import { AgentLoop } from "../agent/loop.js";

interface SwarmInstance {
    id: string;
    role: string;
    loop: AgentLoop;
}

const activeAgents = new Map<string, SwarmInstance>();

export async function spawnSubAgent(roleDescription: string, initialTask: string): Promise<string> {
    const agentId = `sub_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    console.log(`🤖 [Swarm] Spawning sub-agent [${agentId}] Role: ${roleDescription.substring(0, 50)}...`);

    const loop = new AgentLoop();
    activeAgents.set(agentId, { id: agentId, role: roleDescription, loop });

    const systemPrompt = `[SUB-AGENT DIRECTIVE]
You are a highly specialized sub-agent spawned by TradingClaw.
Your specific role is: ${roleDescription}

You have the same tool access as the primary agent, but your focus is entirely on fulfilling your role.
Complete the requested task directly. Output ONLY the final result of your work. Do not make small talk.`;

    try {
        // A sub-agent executes within its own isolated, ephemeral history memory bounds
        const history = [{ role: "user" as const, content: initialTask }];
        const result = await loop.run(history, systemPrompt, "low"); // Default "low" thinking for sub-agents to save time

        console.log(`✅ [Swarm] Sub-agent [${agentId}] completed task.`);
        activeAgents.delete(agentId);

        return result;
    } catch (err: any) {
        console.error(`❌ [Swarm] Sub-agent [${agentId}] failed:`, err);
        activeAgents.delete(agentId);
        return `Sub-agent execution failed: ${err.message}`;
    }
}

// ── Native LLM Tool Bindings ──────────────────────────────────────────────────

registerTool(
    "delegate_task",
    "Spawn an isolated sub-agent to handle a complex parallel task, research, or multi-step logic without polluting your main context window.",
    {
        type: "object",
        properties: {
            agentRole: { type: "string", description: "Who the sub-agent should act as (e.g. 'Senior Python Code Reviewer', 'Macroeconomics Researcher')." },
            prompt: { type: "string", description: "The exact, detailed task they need to complete." }
        },
        required: ["agentRole", "prompt"],
    },
    async (input) => {
        try {
            const role = input.agentRole as string;
            const prompt = input.prompt as string;

            // This await blocks the primary LLM function call until the sub-agent fully completes its inner loop.
            const result = await spawnSubAgent(role, prompt);
            return `[Sub-Agent ${role} Output]:\n${result}`;
        } catch (err: any) {
            return `Failed to delegate task: ${err.message}`;
        }
    }
);
