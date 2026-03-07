import cron from "node-cron";
import { config } from "./config.js";
import { handleMessage } from "./agent.js";
import { bot } from "./bot.js";

interface ScheduledTask {
    name: string;
    schedule: string;    // Cron expression (e.g. "0 8 * * *" = 8 AM daily)
    prompt: string;      // What to "say" to the agent to trigger the check-in
    job?: cron.ScheduledTask;
}

const defaultTasks: ScheduledTask[] = [
    {
        name: "Morning Briefing",
        schedule: "0 8 * * *", // Every day at 8:00 AM
        prompt:
            "It's time for the morning briefing. Greet the user, tell them the current time and date, and give a short motivational quote to start the day. If you have any stored memories about the user's ongoing projects or tasks, mention them briefly.",
    },
    {
        name: "Evening Check-in",
        schedule: "0 20 * * *", // Every day at 8:00 PM
        prompt:
            "It's time for the evening check-in. Ask the user how their day went and if there's anything they'd like you to remember or any tasks for tomorrow.",
    },
];

/**
 * Start the heartbeat scheduler.
 * Sends proactive messages to the first allowed user at scheduled intervals.
 */
export function startScheduler(): void {
    if (!config.heartbeatEnabled) {
        console.log("ℹ️  Heartbeat scheduler is disabled (HEARTBEAT_ENABLED=false)");
        return;
    }

    const targetChatId = config.allowedUserIds[0]; // Send to the primary user
    if (!targetChatId) {
        console.warn("⚠️  No allowed user IDs configured, skipping heartbeat scheduler.");
        return;
    }

    const tz = config.heartbeatTimezone;

    for (const task of defaultTasks) {
        const job = cron.schedule(
            task.schedule,
            async () => {
                console.log(`\n⏰ [Heartbeat] Firing: ${task.name}`);
                try {
                    const reply = await handleMessage(targetChatId, task.prompt);

                    // Send the proactive message via Telegram
                    await bot.api.sendMessage(targetChatId, reply);
                    console.log(`✅ [Heartbeat] Sent: ${task.name}`);
                } catch (err) {
                    console.error(`❌ [Heartbeat] Failed: ${task.name}`, err);
                }
            },
            {
                timezone: tz,
            }
        );

        task.job = job;
        console.log(`  ⏰ Scheduled: "${task.name}" at cron(${task.schedule}) [${tz}]`);
    }

    console.log(`✅ Heartbeat scheduler started with ${defaultTasks.length} tasks.`);
}
