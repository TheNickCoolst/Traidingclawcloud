import { config } from "./config.js";
import { telegramChannel, bot } from "./bot.js";
import { loadSkills } from "./skills/manager.js";
import { loadPlugins } from "./architecture/plugins.js";
import fs from "fs";
import path from "path";
import { startWebhookServer } from "./automation/webhooks.js";
import "./automation/scheduler.js"; // side-effect tool registry import
import { router } from "./channels/router.js";
import { handleMessage } from "./agent.js";
import { connectMcpServers } from "./mcp.js";
import { startHeartbeat, stopHeartbeat } from "./automation/heartbeat.js";
import "./tools/shell.js"; // Initialize shell tool
import { startTradingEngine, stopTradingEngine } from "./trading/engine.js";
import { overrideConsole, setupDailyLogDelivery, stopDailyLogDelivery } from "./logger.js";

const STARTUP_NOTIFY_STATE_PATH = path.join(process.cwd(), "data", "startup-notify.json");
const APP_LOCK_PATH = path.join(process.cwd(), "data", `tradingclaw-app-${config.runtimeRole}.lock`);
const STARTUP_NOTIFY_MINUTES = Number(process.env["STARTUP_NOTIFY_MINUTES"] ?? "360");
const STARTUP_NOTIFY_MIN_MS = Math.max(1, STARTUP_NOTIFY_MINUTES) * 60 * 1000;
let startupNotifiedInProcess = false;
let shutdownInProgress = false;
let shutdownHooksRegistered = false;

function shouldSendStartupNotification(): boolean {
    if ((process.env["STARTUP_NOTIFY_ENABLED"] ?? "true") !== "true") return false;

    const isDev = process.env["NODE_ENV"] === "development";
    const isTsxWatch = process.argv.some((arg) => arg.includes("tsx"));
    const allowInDev = (process.env["STARTUP_NOTIFY_IN_DEV"] ?? "false") === "true";
    if ((isDev || isTsxWatch) && !allowInDev) return false;

    try {
        if (!fs.existsSync(STARTUP_NOTIFY_STATE_PATH)) return true;
        const raw = fs.readFileSync(STARTUP_NOTIFY_STATE_PATH, "utf-8");
        const parsed = JSON.parse(raw) as { lastSentAt?: string };
        const last = parsed.lastSentAt ? new Date(parsed.lastSentAt).getTime() : 0;
        if (!Number.isFinite(last) || last <= 0) return true;
        return (Date.now() - last) >= STARTUP_NOTIFY_MIN_MS;
    } catch {
        return true;
    }
}

function markStartupNotificationSent(): void {
    try {
        const dir = path.dirname(STARTUP_NOTIFY_STATE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            STARTUP_NOTIFY_STATE_PATH,
            JSON.stringify({ lastSentAt: new Date().toISOString() }),
            "utf-8"
        );
    } catch {
        // best effort
    }
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function acquireAppLock(): boolean {
    try {
        const dir = path.dirname(APP_LOCK_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Atomic lock create to avoid race conditions between near-simultaneous starts.
        try {
            const fd = fs.openSync(APP_LOCK_PATH, "wx");
            fs.writeFileSync(fd, String(process.pid), "utf-8");
            fs.closeSync(fd);
            return true;
        } catch (err: any) {
            if (err?.code !== "EEXIST") throw err;
        }

        const raw = fs.readFileSync(APP_LOCK_PATH, "utf-8").trim();
        const existingPid = Number(raw);
        if (existingPid && existingPid !== process.pid && isProcessAlive(existingPid)) {
            console.error(`⛔ TradingClaw app already running in PID ${existingPid}. Refusing second instance.`);
            return false;
        }

        // Stale lock file from a dead process: remove and retry once.
        try {
            fs.unlinkSync(APP_LOCK_PATH);
        } catch {
            // best effort
        }
        const fd = fs.openSync(APP_LOCK_PATH, "wx");
        fs.writeFileSync(fd, String(process.pid), "utf-8");
        fs.closeSync(fd);
        return true;
    } catch (err: any) {
        console.error("⚠️ Failed to acquire app lock:", err.message);
        return false;
    }
}

function releaseAppLock(): void {
    try {
        if (!fs.existsSync(APP_LOCK_PATH)) return;
        const raw = fs.readFileSync(APP_LOCK_PATH, "utf-8").trim();
        const lockPid = Number(raw);
        if (lockPid === process.pid) {
            fs.unlinkSync(APP_LOCK_PATH);
        }
    } catch {
        // best effort
    }
}

function cleanupRuntime(): void {
    try {
        stopTradingEngine();
    } catch {
        // best effort
    }
    try {
        stopHeartbeat();
    } catch {
        // best effort
    }
    try {
        stopDailyLogDelivery();
    } catch {
        // best effort
    }
    try {
        bot.stop();
    } catch {
        // best effort
    }
    releaseAppLock();
}

function registerShutdownHooks(): void {
    if (shutdownHooksRegistered) return;

    const shutdown = () => {
        if (shutdownInProgress) return;
        shutdownInProgress = true;
        console.log("\n🛑 Shutting down...");
        cleanupRuntime();
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.once("exit", releaseAppLock);
    shutdownHooksRegistered = true;
}

function isTelegramPollingConflict(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err ?? "");
    return message.includes("409: Conflict") && message.includes("getUpdates");
}

async function main() {
    // 0. Initialize logging
    overrideConsole();
    setupDailyLogDelivery();

    console.log("┌─────────────────────────────────────────┐");
    console.log("│     📈 TradingClaw v2.0.1 — Trading Bot │");
    console.log("│         Paper Trading Mode               │");
    console.log("├─────────────────────────────────────────┤");
    console.log(`│  Model:    ${config.model.padEnd(28)}│`);
    console.log(`│  Users:    ${config.allowedUserIds.join(", ").padEnd(28)}│`);
    console.log(`│  Cycle:    Every ${String(config.tradingCycleHours) + "h"}${" ".repeat(22)}│`);
    console.log("└─────────────────────────────────────────┘");
    console.log(`🔒 PID: ${process.pid}`);
    console.log(`🧩 Runtime role: ${config.runtimeRole}`);
    console.log("");

    console.log("🔌 Connecting to MCP Servers...");
    await connectMcpServers();
    console.log("");

    console.log("⏰ Proactive Trading Routines:");
    console.log("   disabled (engine scheduler is authoritative).");
    startHeartbeat();
    console.log("");

    console.log("📈 Starting Trading Engine...");
    const engineStarted = await startTradingEngine();
    if (!engineStarted) {
        console.error("⛔ Trading engine did not start. Aborting startup before Telegram polling.");
        cleanupRuntime();
        return;
    }
    console.log("");

    startWebhookServer();

    if (!config.telegramEnabled) {
        router.register(telegramChannel);
        console.log(`Runtime role "${config.runtimeRole}" running without Telegram polling.`);
        registerShutdownHooks();
        return;
    }

    console.log("🚀 Starting Telegram interface...");

    // 1. Initialize dynamic architecture resources
    await loadPlugins();
    await loadSkills();

    // 2. Register known channels
    router.register(telegramChannel);

    router.receive(async (channelId, message) => {
        try {
            const replyText = await handleMessage(Number(message.chatId), message.text);
            await router.send(channelId, {
                chatId: message.chatId,
                userId: message.userId,
                text: replyText,
                metadata: message.metadata // Pass voice reply back if present
            });
        } catch (err) {
            console.error(`❌ Router receive error on ${channelId}:`, err);
            await router.send(channelId, {
                chatId: message.chatId,
                userId: message.userId,
                text: "⚠️ Something went wrong processing your message. Check the logs."
            });
        }
    });

    console.log("🚀 Starting Telegram long polling...");
    console.log("   Press Ctrl+C to stop.\n");
    registerShutdownHooks();

    // Start long polling — no web server, no exposed ports
    await bot.start({
        onStart: async (info) => {
            console.log(`✅ Bot started as @${info.username}`);
            
            // Notify admin of startup
            const adminId = config.allowedUserIds[0];
            if (adminId && !startupNotifiedInProcess && shouldSendStartupNotification()) {
                await bot.api.sendMessage(
                    adminId,
                    "🚀 *TradingClaw v2.0.1 is now online and active.*\nLogs will be sent daily at 00:05.",
                    { parse_mode: "Markdown" }
                ).then(() => {
                    startupNotifiedInProcess = true;
                    markStartupNotificationSent();
                }).catch((e) => console.error("Failed to send startup notification:", e.message));
            }

            // Set up native UX slashed commands menu in Telegram
            await bot.api.setMyCommands([
                { command: "status", description: "📊 View trading status & positions" },
                { command: "trade", description: "🔄 Manually trigger a trading cycle" },
                { command: "reflect", description: "🧠 Manually trigger a reflection cycle" },
                { command: "usage", description: "📈 View API token usage stats" },
                { command: "logs", description: "📄 Get current daily log file" },
                { command: "new", description: "🧹 Wipe session memory to start fresh" },
                { command: "compact", description: "📦 Manually force compress context" },
                { command: "ping", description: "🏓 Check heartbeat / backend status" }
            ]).catch(err => console.error("⚠️ Failed to set Telegram bot commands UI:", err.message));
        },
    });
}

async function startWithAutoRestart() {
    if (!acquireAppLock()) return;
    try {
        await main();
    } catch (err) {
        console.error("💥 Fatal error:", err);
        cleanupRuntime();
        if (isTelegramPollingConflict(err)) {
            console.error("⛔ Telegram polling conflict (409): another bot instance is running with the same token. Auto-restart stopped to prevent loops.");
            return;
        }
        console.error("🛑 TradingClaw stopped after fatal error. Start it again after fixing the cause.");
    }
}

startWithAutoRestart();
