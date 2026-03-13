import { config } from "./config.js";
import fs from "fs";
import path from "path";
import { registerTelegramWebhookHandler, startWebhookServer } from "./automation/webhooks.js";
import { router } from "./channels/router.js";
import { connectMcpServers } from "./mcp.js";
import { startHeartbeat, stopHeartbeat } from "./automation/heartbeat.js";
import "./tools/shell.js"; // Keep shell tool available for main-cycle agent decisions.
import { getBotActivityStatus, startTradingEngine, stopTradingEngine } from "./trading/engine.js";
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
const FATAL_RESTART_ENABLED = (process.env["APP_FATAL_RESTART_ENABLED"] ?? "true") === "true";
const FATAL_RESTART_BASE_DELAY_MS = Math.max(1_000, Number(process.env["APP_FATAL_RESTART_BASE_DELAY_MS"] ?? "5_000".replace(/_/g, "")));
const FATAL_RESTART_MAX_DELAY_MS = Math.max(FATAL_RESTART_BASE_DELAY_MS, Number(process.env["APP_FATAL_RESTART_MAX_DELAY_MS"] ?? "60_000".replace(/_/g, "")));
const FATAL_RESTART_MAX_ATTEMPTS = Math.max(0, Number(process.env["APP_FATAL_RESTART_MAX_ATTEMPTS"] ?? "0"));
let startupNotifiedInProcess = false;
let shutdownInProgress = false;
let shutdownHooksRegistered = false;
let activeBot: TelegramBotRuntime | null = null;
let activeRunReject: ((err: unknown) => void) | null = null;
let fatalRuntimeHooksRegistered = false;
let marketClosedExitInterval: NodeJS.Timeout | null = null;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportFatalRuntimeError(err: unknown): void {
    if (shutdownInProgress) return;
    if (activeRunReject) {
        activeRunReject(err);
        return;
    }
    console.error("Fatal runtime error without active supervisor:", err);
}

function registerFatalRuntimeHooks(): void {
    if (fatalRuntimeHooksRegistered) return;

    process.on("uncaughtException", (err) => {
        console.error("Uncaught exception:", err);
        reportFatalRuntimeError(err);
    });
    process.on("unhandledRejection", (reason) => {
        console.error("Unhandled rejection:", reason);
        reportFatalRuntimeError(reason);
    });
    fatalRuntimeHooksRegistered = true;
}

function createFatalRunPromise(): Promise<never> {
    return new Promise((_, reject) => {
        activeRunReject = reject;
    });
}

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
    if (marketClosedExitInterval) {
        clearInterval(marketClosedExitInterval);
        marketClosedExitInterval = null;
    }
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

function requestMarketClosedShutdown(reason: string): void {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    console.log(reason);
    cleanupRuntime();
    process.exit(0);
}

function maybeExitWhenMarketClosed(context: string): void {
    if (!config.marketClosedExitEnabled) return;
    const status = getBotActivityStatus();
    if (status.active) return;
    requestMarketClosedShutdown(`[Runtime] ${context}: outside US market hours (${status.hour}:${String(status.minute).padStart(2, "0")} ET). Exiting to save runtime cost.`);
}

function startMarketClosedExitGuard(): void {
    if (!config.marketClosedExitEnabled || marketClosedExitInterval) return;

    maybeExitWhenMarketClosed("Startup guard");

    const intervalMinutes = Math.max(1, Math.floor(config.marketClosedExitCheckMinutes || 5));
    marketClosedExitInterval = setInterval(() => {
        maybeExitWhenMarketClosed("Off-hours guard");
    }, intervalMinutes * 60 * 1000);
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

async function completeTelegramBotStartup(bot: TelegramBotRuntime): Promise<void> {
    let botInfo: { username?: string } | null = null;
    try {
        botInfo = await (bot.api as any).getMe();
    } catch (err: any) {
        console.error("Failed to fetch Telegram bot identity:", err.message);
    }

    if (botInfo?.username) {
        console.log(`Bot started as @${botInfo.username}`);
    }

    const adminId = config.allowedUserIds[0];
    if (adminId && !startupNotifiedInProcess && shouldSendStartupNotification()) {
        await bot.api.sendMessage(
            adminId,
            "TradingClaw v2.0.1 is now online and active.\nLogs will be sent daily at 00:05.",
            { parse_mode: "Markdown" }
        ).then(() => {
            startupNotifiedInProcess = true;
            markStartupNotificationSent();
            console.log("[Telegram] Startup notification delivered to admin.");
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

    startMarketClosedExitGuard();
    console.log("");

    startWebhookServer();

    if (!config.telegramEnabled) {
        // Low-memory path: outbound notifications only, no polling handlers.
        if (config.telegramBotToken) {
            const { telegramApiChannel } = await import("./channels/telegram-api-channel.js");
            router.register(telegramApiChannel);
            console.log(`Runtime role "${config.runtimeRole}" running in low-memory Telegram outbound mode.`);
        } else {
            console.warn(`Runtime role "${config.runtimeRole}" started without Telegram outbound because TELEGRAM_BOT_TOKEN is missing.`);
        }
        registerShutdownHooks();
        await createFatalRunPromise();
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

    registerShutdownHooks();

    if (config.telegramWebhookEnabled) {
        const webhookUrl = config.telegramWebhookUrl?.trim();
        if (!webhookUrl) {
            throw new Error("TELEGRAM_WEBHOOK_ENABLED=true but TELEGRAM_WEBHOOK_URL is empty.");
        }

        registerTelegramWebhookHandler(async (update: unknown) => {
            await bot.handleUpdate(update as any);
        });

        const secretToken = config.telegramWebhookSecretToken?.trim();
        await bot.init();
        await bot.api.setWebhook(webhookUrl, secretToken ? { secret_token: secretToken } : {});
        await completeTelegramBotStartup(bot as TelegramBotRuntime);
        console.log(`Telegram webhook mode enabled: ${webhookUrl}`);
        await createFatalRunPromise();
        return;
    }

    console.log("Starting Telegram long polling...");
    console.log("Press Ctrl+C to stop.\n");

    await bot.api.deleteWebhook().catch((err: any) => {
        console.error("Failed to clear Telegram webhook before polling mode:", err.message);
    });

    await Promise.race([
        bot.start({
            onStart: async () => {
                await completeTelegramBotStartup(bot as TelegramBotRuntime);
            },
        }),
        createFatalRunPromise(),
    ]);
}

async function startWithAutoRestart() {
    registerFatalRuntimeHooks();

    if (!acquireAppLock()) return;

    let attempt = 0;
    while (true) {
        activeRunReject = null;
        try {
            await main();
            return;
        } catch (err) {
            attempt += 1;
            console.error("Fatal error:", err);
            cleanupRuntime();
            activeRunReject = null;

            if (shutdownInProgress) return;
            if (isTelegramPollingConflict(err)) {
                console.error("Telegram polling conflict (409): another bot instance is running with the same token. Auto-restart stopped to prevent loops.");
                return;
            }
            if (!FATAL_RESTART_ENABLED) {
                console.error("TradingClaw stopped after fatal error. Auto-restart is disabled.");
                return;
            }
            if (FATAL_RESTART_MAX_ATTEMPTS > 0 && attempt >= FATAL_RESTART_MAX_ATTEMPTS) {
                console.error(`TradingClaw stopped after fatal error. Reached restart limit (${FATAL_RESTART_MAX_ATTEMPTS}).`);
                return;
            }

            const delayMs = Math.min(FATAL_RESTART_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)), FATAL_RESTART_MAX_DELAY_MS);
            console.error(`TradingClaw restarting after fatal error in ${Math.round(delayMs / 1000)}s (attempt ${attempt}).`);
            await sleep(delayMs);

            if (!acquireAppLock()) {
                console.error("TradingClaw restart aborted: app lock is held by another process.");
                return;
            }
        }
    }
}

startWithAutoRestart();
