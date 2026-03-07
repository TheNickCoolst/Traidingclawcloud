import { router } from "../channels/router.js";
import { config } from "../config.js";

let heartbeatTimeout: NodeJS.Timeout | null = null;

function getRootAdminId(): number {
    return Number(config.allowedUserIds[0] || 0);
}

export function startHeartbeat() {
    if (!config.heartbeatIntervalMinutes || config.heartbeatIntervalMinutes <= 0) {
        console.log("ℹ️ [Heartbeat] Disabled in configuration.");
        return;
    }

    const intervalMs = config.heartbeatIntervalMinutes * 60 * 1000;
    console.log(`💓 [Heartbeat] Started. Pulsing every ${config.heartbeatIntervalMinutes} minutes.`);

    const pulse = async () => {
        const adminId = getRootAdminId();
        const prompt = `[SYSTEM TRIGGER: HEARTBEAT METRONOME]
A background interval has fired. You are "waking up".
Do the following:
1. Examine your memory and recent session history (if necessary).
2. Determine if there is ANY proactive action you should take right now (e.g. informing the user of something important, checking a pending status, etc).
3. If YES, formulate a message and it will be sent to the user.
4. If NO, output exactly "NO_ACTION_REQUIRED" and stop immediately. Do NOT send "NO_ACTION_REQUIRED" to the user verbally, it is a system flag.`;

        try {
            // We use the 'agent' channel for internal silent monologue mapping,
            // or we use telegram if we just want it to drop right into the main routing logic 
            // and act as a hidden prompt. Given our setup, dispatching to Telegram
            // with a metadata flag allows the router filtering.

            // To ensure it doesn't just spam the user with random thoughts, 
            // we will intercept "NO_ACTION_REQUIRED" inside the dispatcher later, 
            // or simply let the agent's return response handle it.
            // Actually, we'll just inject it. The LLM's raw response will be yielded.

            await router.dispatch("telegram", {
                chatId: adminId,
                text: prompt,
                userId: adminId,
                metadata: { automaticTask: true, isHeartbeat: true }
            });

        } catch (err: any) {
            console.error("Heartbeat error failed to execute pulse:", err.message);
        }

        heartbeatTimeout = setTimeout(pulse, intervalMs);
    };

    // Begin looping
    heartbeatTimeout = setTimeout(pulse, intervalMs);
}

export function stopHeartbeat() {
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
    console.log("⏸️ [Heartbeat] Stopped.");
}
