import { registerTool } from "../tools/index.js";
import { AgentLoop } from "../agent/loop.js";

// A Workflow is a predefined array of rigid system prompts executed in succession
type WorkflowMap = Record<string, string[]>;

const availableWorkflows: WorkflowMap = {
    // Example mesh
    "crypto_analysis": [
        "Step 1: Execute a web search for latest news on the requested crypto asset. Output specific key price-moving narratives.",
        "Step 2: Take the exact output from Step 1, analyze sentiment (Bullish/Bearish) and format it into a Markdown table.",
        "Step 3: Review the table from Step 2. Act as an editor and summarize the final conclusion."
    ],
    // Add more predefined templates here...
};

export async function executeMeshWorkflow(workflowName: string, initialContext: string): Promise<string> {
    const steps = availableWorkflows[workflowName];
    if (!steps) throw new Error(`Workflow '${workflowName}' not found.`);

    console.log(`🔗 [Mesh] Starting workflow: ${workflowName} (${steps.length} steps) with context: ${initialContext}`);

    let rollingContext = initialContext;

    // Linear sequential pipeline agent execution
    for (let i = 0; i < steps.length; i++) {
        console.log(`   ⚙️ [Mesh] Executing Step ${i + 1}/${steps.length}`);

        const loop = new AgentLoop();
        const systemPrompt = `[WORKFLOW PIPELINE MODE]
You are a deterministic step-processor. You must execute exactly the instructions required for this step. Do not deviate.
YOUR STEP INSTRUCTIONS:
${steps[i]}

PREVIOUS STEP OUTPUT / INITIAL CONTEXT:
${rollingContext}`;

        try {
            const history = [{ role: "user" as const, content: "Execute your step." }];
            const stepResult = await loop.run(history, systemPrompt, "off");
            rollingContext = stepResult;
        } catch (err: any) {
            throw new Error(`Workflow collapsed at step ${i + 1}: ${err.message}`);
        }
    }

    console.log(`✅ [Mesh] Workflow ${workflowName} completed.`);
    return rollingContext; // Returns the ultimate step output
}

// ── Native LLM Tool Bindings ──────────────────────────────────────────────────

registerTool(
    "start_workflow",
    `Trigger a deterministic multi-step predefined pipeline. Available workflows: ${Object.keys(availableWorkflows).join(", ")}.`,
    {
        type: "object",
        properties: {
            workflowName: { type: "string" },
            initialContext: { type: "string", description: "The starting parameter (e.g. 'BTC', or code block)" }
        },
        required: ["workflowName", "initialContext"],
    },
    async (input) => {
        try {
            const result = await executeMeshWorkflow(input.workflowName as string, input.initialContext as string);
            return `[Workflow ${input.workflowName} Final Output]:\n${result}`;
        } catch (err: any) {
            return `Workflow failed: ${err.message}`;
        }
    }
);
