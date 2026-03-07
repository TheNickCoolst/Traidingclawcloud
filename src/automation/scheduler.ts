import cron from "node-cron";
import { router } from "../channels/router.js";
import { registerTool } from "../tools/index.js";

interface Task {
    id: string;
    schedule: string;
    prompt: string;
}

const activeTasks = new Map<string, cron.ScheduledTask>();

export function scheduleAgentTask(schedule: string, prompt: string, debugChannel: string = "telegram"): string {
    const taskId = `task_${Date.now()}`;

    // We arbitrarily bind the system chron jobs to user ID #1 (the root admin of the bot)
    // in TradingClaw this mimics a user texting the bot on schedule.
    const rootAdminId = Number(process.env.ALLOWED_USER_IDS?.split(',')[0] || "0");

    const job = cron.schedule(schedule, async () => {
        console.log(`⏰ [Scheduler] Executing task ${taskId}: ${prompt}`);
        try {
            await router.dispatch(debugChannel, {
                chatId: rootAdminId,
                text: prompt,
                userId: rootAdminId,
                metadata: { automaticTask: true }
            });
        } catch (err: any) {
            console.error(`[Scheduler] Failed executing task ${taskId}`, err);
        }
    });

    activeTasks.set(taskId, job);
    return taskId;
}

export function cancelTask(taskId: string): boolean {
    const job = activeTasks.get(taskId);
    if (!job) return false;
    job.stop();
    activeTasks.delete(taskId);
    return true;
}

// ── Native LLM Tool Bindings ──────────────────────────────────────────────────

registerTool(
    "schedule_task",
    "Schedule an automated task to run on a chron schedule. Use this to set reminders or background monitoring.",
    {
        type: "object",
        properties: {
            schedule: { type: "string", description: "Standard cron syntax (e.g. '0 9 * * *' for 9 AM daily, '*/5 * * * *' for every 5 mins)." },
            prompt: { type: "string", description: "The natural language instruction you want executed at that time (e.g., 'Check ETH price')." }
        },
        required: ["schedule", "prompt"],
    },
    async (input) => {
        try {
            const taskId = scheduleAgentTask(input.schedule as string, input.prompt as string);
            return `Task scheduled successfully with ID: ${taskId} on schedule [${input.schedule}]`;
        } catch (err: any) {
            return `Failed to schedule task: ${err.message}`;
        }
    }
);
