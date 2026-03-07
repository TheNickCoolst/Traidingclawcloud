import cron from "node-cron";
import { router } from "../channels/router.js";
import { config } from "../config.js";
import { manualTradingCycle, manualReflectionCycle } from "../trading/engine.js";
import type { ScheduledTask } from "node-cron";

let proactiveJobs: ScheduledTask[] = [];

function getRootAdminId(): number {
    return Number(config.allowedUserIds[0] || 0);
}

/** Notify admin via Telegram */
async function notifyAdmin(message: string): Promise<void> {
    const adminId = getRootAdminId();
    if (!adminId) return;

    try {
        await router.send("telegram", {
            chatId: adminId,
            userId: adminId,
            text: message.slice(0, 4000),
        });
    } catch (err: any) {
        console.error("📢 Notification failed:", err.message);
    }
}

export function startProactiveRoutines() {
    if (proactiveJobs.length > 0) {
        console.log("🌅 [Proactive] Routines already active. Skipping duplicate initialization.");
        return;
    }
    console.log("🌅 [Proactive] Initializing Trading Routines...");

    // -- MARKET OPEN ANALYSIS (Fires at 15:30 CET / 9:30 AM ET on weekdays) --
    const marketOpenJob = cron.schedule("30 15 * * 1-5", async () => {
        console.log("🔔 [Proactive] Market Open — Running trading analysis...");
        try {
            const result = await manualTradingCycle();
            await notifyAdmin(`🔔 **Market Open Trading Cycle**\n\n${result.slice(0, 3000)}`);
        } catch (err: any) {
            console.error("Market open trading cycle failed:", err.message);
        }
    });

    // -- MARKET CLOSE CHECK (Fires at 22:00 CET / 4:00 PM ET on weekdays) --
    const marketCloseJob = cron.schedule("0 22 * * 1-5", async () => {
        console.log("🌙 [Proactive] Market Close — Running end-of-day analysis...");
        try {
            const result = await manualTradingCycle();
            await notifyAdmin(`🌙 **Market Close Trading Cycle**\n\n${result.slice(0, 3000)}`);
        } catch (err: any) {
            console.error("Market close trading cycle failed:", err.message);
        }
    });

    // -- DAILY SELF-REFLECTION (Fires daily at 23:00 CET) --
    const reflectionJob = cron.schedule("0 23 * * *", async () => {
        console.log("🧠 [Proactive] Daily Self-Reflection firing...");
        try {
            const result = await manualReflectionCycle();
            await notifyAdmin(`🧠 **Daily Trading Reflection**\n\n${result.slice(0, 3000)}`);
        } catch (err: any) {
            console.error("Daily reflection failed:", err.message);
        }
    });

    proactiveJobs = [marketOpenJob, marketCloseJob, reflectionJob];

    console.log("   📅 Market Open analysis:   15:30 CET (Mon-Fri)");
    console.log("   📅 Market Close analysis:  22:00 CET (Mon-Fri)");
    console.log("   📅 Daily Reflection:       23:00 CET (Daily)");
}

export function stopProactiveRoutines() {
    if (proactiveJobs.length === 0) return;
    for (const job of proactiveJobs) job.stop();
    proactiveJobs = [];
    console.log("🌙 [Proactive] Routines stopped.");
}
