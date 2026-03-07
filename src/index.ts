import { config } from "./config.js";
import fs from "fs";
import path from "path";
import { startWebhookServer } from "./automation/webhooks.js";
import { router } from "./channels/router.js";
import { connectMcpServers } from "./mcp.js";
import { startHeartbeat, stopHeartbeat } from "./automation/heartbeat.js";
import "./tools/shell.js"; // Keep shell tool available for main-cycle agent decisions.
import { startTradingEngine, stopTradingEngine } from "./trading/engine.js";
import { overrideConsole, setupDailyLogDelivery, stopDailyLogDelivery } from "./logger.js";

interface TelegramBotRuntime {
    stop(): void;
    start(options: Record<string, unknown>): Promise<void>;
    api: {
        sendMessage(chatId: number, text: string, extra?: Record<string, unknown>): Promise<unknown>;
        setMyCommands(commands: Array<{ command: string; description: string }>): Promise<unknown>;
    };
}

const STARTUP_NOTIFY_STATE_PATH = path.join(process.cwd(), "data", "startup-notify.json");
const APP_LOCK_PATH = path.join(process.cwd(), "data", `tradingclaw-app-${config.runtimeRole}.lock`);
const STARTUP_NOTIFY_MINUTES = Number(process.env["STARTUP_NOTIFY_MINUTES"] ?? "360");
const STARTUP_NOTIFY_MIN_MS = Math.max(1, STARTUP_NOTIFY_MINUTES) * 60 * 1000;
let startupNotifiedInProcess = false;
let shutdownInProgress = false;
let shutdownHooksRegistered = false;
let activeBot: TelegramBotRuntime | null = null;

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
            console.error(`TradingClaw app already running in PID ${existingPid}. Refusing second instance.`);
            return false;
        }

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
        console.error("Failed to acquire app lock:", err.message);
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
        activeBot?.stop();
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
        console.log("\nShutting down...");
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

function runtimeCanRunMainCycle(): boolean {
    return config.runtimeRole === "all" || config.runtimeRole === "main";
}

async function maybeLoadSchedulerTools(): Promise<void> {
    if (!runtimeCanRunMainCycle()) return;
    await import("./automation/scheduler.js");
}

async function maybeLoadMainCycleToolset(): Promise<void> {
    if (!runtimeCanRunMainCycle()) return;

    // Preserve full main-cycle tool availability without forcing the Telegram polling stack
    // on light/ultra runtimes.
    await Promise.all([
        import("./tools/get-current-time.js"),
        import("./tools/memory.js"),
        import("./tools/fs.js"),
        import("./tools/search.js"),
        import("./tools/browser.js"),
        import("./trading/tools.js"),
        import("./architecture/swarm.js"),
        import("./architecture/workflows.js"),
    ]);
}

async function main() {
    overrideConsole();
    setupDailyLogDelivery();

    console.log("TradingClaw v2.0.1 starting...");
    console.log(`PID: ${process.pid}`);
    console.log(`Runtime role: ${config.runtimeRole}`);
    console.log(`Telegram enabled: ${config.telegramEnabled}`);
    console.log(`MCP enabled: ${config.mcpEnabled}`);
    console.log("");

    if (config.mcpEnabled) {
        console.log("Connecting to MCP Servers...");
        await connectMcpServers();
    } else {
        console.log("Skipping MCP server startup for this runtime role.");
    }
    console.log("");

    // Keep scheduler + full toolset only on runtimes that can execute full main cycles.
    await maybeLoadSchedulerTools();
    await maybeLoadMainCycleToolset();

    console.log("Proactive Trading Routines:");
    console.log("   disabled (engine scheduler is authoritative).");
    startHeartbeat();
    console.log("");

    console.log("Starting Trading Engine...");
    const engineStarted = await startTradingEngine();
    if (!engineStarted) {
        console.error("Trading engine did not start. Aborting startup before Telegram polling.");
        cleanupRuntime();
        return;
    }
    console.log("");

    startWebhookServer();

    if (!config.telegramEnabled) {
        // Low-memory path: outbound notifications only, no polling handlers.
        const { telegramApiChannel } = await import("./channels/telegram-api-channel.js");
        router.register(telegramApiChannel);
        console.log(`Runtime role "${config.runtimeRole}" running in low-memory Telegram outbound mode.`);
        registerShutdownHooks();
        return;
    }

    console.log("Starting Telegram interface...");

    const [botModule, skillsModule, pluginsModule, agentModule] = await Promise.all([
        import("./bot.js"),
        import("./skills/manager.js"),
        import("./architecture/plugins.js"),
        import("./agent.js"),
    ]);

    const { telegramChannel, bot } = botModule;
    const { loadSkills } = skillsModule;
    const { loadPlugins } = pluginsModule;
    const { handleMessage } = agentModule;

    activeBot = bot as TelegramBotRuntime;

    await loadPlugins();
    await loadSkills();

    router.register(telegramChannel);

    router.receive(async (channelId, message) => {
        try {
            const replyText = await handleMessage(Number(message.chatId), message.text);
            await router.send(channelId, {
                chatId: message.chatId,
                userId: message.userId,
                text: replyText,
                metadata: message.metadata,
            });
        } catch (err) {
            console.error(`Router receive error on ${channelId}:`, err);
            await router.send(channelId, {
                chatId: message.chatId,
                userId: message.userId,
                text: "Something went wrong processing your message. Check the logs.",
            });
        }
    });

    console.log("Starting Telegram long polling...");
    console.log("Press Ctrl+C to stop.\n");
    registerShutdownHooks();

    await bot.start({
        onStart: async (info: any) => {
            console.log(`Bot started as @${info.username}`);

            const adminId = config.allowedUserIds[0];
            if (adminId && !startupNotifiedInProcess && shouldSendStartupNotification()) {
                await bot.api.sendMessage(
                    adminId,
                    "TradingClaw v2.0.1 is now online and active.\nLogs will be sent daily at 00:05.",
                    { parse_mode: "Markdown" }
                ).then(() => {
                    startupNotifiedInProcess = true;
                    markStartupNotificationSent();
                }).catch((e: any) => console.error("Failed to send startup notification:", e.message));
            }

            await bot.api.setMyCommands([
                { command: "status", description: "View trading status and positions" },
                { command: "trade", description: "Manually trigger a trading cycle" },
                { command: "reflect", description: "Manually trigger a reflection cycle" },
                { command: "usage", description: "View API token usage stats" },
                { command: "logs", description: "Get current daily log file" },
                { command: "new", description: "Wipe session memory to start fresh" },
                { command: "compact", description: "Manually force context compaction" },
                { command: "ping", description: "Check heartbeat or backend status" },
            ]).catch((err: any) => console.error("Failed to set Telegram bot commands UI:", err.message));
        },
    });
}

async function startWithAutoRestart() {
    if (!acquireAppLock()) return;
    try {
        await main();
    } catch (err) {
        console.error("Fatal error:", err);
        cleanupRuntime();
        if (isTelegramPollingConflict(err)) {
            console.error("Telegram polling conflict (409): another bot instance is running with the same token. Auto-restart stopped to prevent loops.");
            return;
        }
        console.error("TradingClaw stopped after fatal error. Start it again after fixing the cause.");
    }
}

startWithAutoRestart();
