import "dotenv/config";

interface Config {
    /** Runtime role for split-cycle deployments */
    runtimeRole: "all" | "main" | "light" | "ultra";
    /** Enable low-cost runtime defaults for constrained Railway deployments */
    railwayBudgetMode: boolean;
    /** Whether Telegram polling and chat commands are enabled on this instance */
    telegramEnabled: boolean;
    /** Whether daily log delivery jobs are enabled on this instance */
    dailyLogDeliveryEnabled: boolean;
    /** Whether logs should also be written to local files */
    logToFileEnabled: boolean;
    /** Whether the main runtime should use Telegram webhooks instead of long polling */
    telegramWebhookEnabled: boolean;
    /** Public Telegram webhook URL for the main runtime */
    telegramWebhookUrl?: string;
    /** Optional Telegram secret token for webhook verification */
    telegramWebhookSecretToken?: string;
    /** Optional Google Drive upload for daily logs */
    googleDriveLogUploadEnabled: boolean;
    /** Google Drive folder id for log uploads */
    googleDriveFolderId?: string;
    /** Service-account email used to authenticate against Google Drive */
    googleServiceAccountEmail?: string;
    /** Service-account private key used to authenticate against Google Drive */
    googleServiceAccountPrivateKey?: string;
    /** Delete local log files after successful Drive upload */
    deleteLocalLogAfterUpload: boolean;
    /** Optional URL of the main-cycle service escalation endpoint */
    escalationMainUrl?: string;
    /** Optional URL of the light-cycle service escalation endpoint */
    escalationLightUrl?: string;
    /** Shared secret used for cross-service escalation calls */
    escalationSharedSecret?: string;
    /** Timeout for cross-service escalation requests */
    escalationRequestTimeoutMs: number;
    /** Telegram bot token from BotFather */
    telegramBotToken?: string;
    /** OpenRouter API key */
    openrouterApiKey: string;
    /** App title sent to OpenRouter for client identification */
    openrouterAppTitle: string;
    /** HTTP referer sent to OpenRouter for client identification */
    openrouterAppReferer: string;
    /** Telegram user IDs allowed to interact with the bot */
    allowedUserIds: number[];
    /** Model identifier (OpenRouter format) */
    model: string;
    /** Provider chain array from .env string (e.g. openrouter,ollama) */
    providerChain: string[];
    /** URL of local ollama instance */
    ollamaHost?: string;
    /** Max agentic loop iterations per message */
    maxToolIterations: number;
    /** OpenAI API key for Whisper transcription */
    openaiApiKey: string;
    /** ElevenLabs API key for TTS */
    elevenlabsApiKey: string;
    /** ElevenLabs Voice ID */
    elevenlabsVoiceId: string;
    /** Path to MCP servers JSON configuration */
    mcpServersConfigPath?: string;
    /** Whether MCP server processes should be connected for this runtime */
    mcpEnabled: boolean;
    /** Whether the heartbeat scheduler is enabled */
    heartbeatEnabled: boolean;
    /** Timezone for heartbeat schedule (IANA format) */
    heartbeatTimezone: string;
    /** Background monologue interval in minutes */
    heartbeatIntervalMinutes: number;
    /** Whether the whole runtime should shut itself down outside US market hours */
    marketClosedExitEnabled: boolean;
    /** Minutes between off-hours shutdown checks */
    marketClosedExitCheckMinutes: number;
    /** Port for webhook HTTP server */
    webhookPort: number;
    /** Max JSON body size accepted by the HTTP server in kilobytes */
    webhookJsonLimitKb: number;
    /** Max URL-encoded body size accepted by the HTTP server in kilobytes */
    webhookFormLimitKb: number;
    /** Sliding window size for webhook rate limiting in milliseconds */
    webhookRateLimitWindowMs: number;
    /** Max webhook requests per window per client */
    webhookRateLimitMax: number;
    /** Optional shared secret required on incoming webhook requests */
    webhookSharedSecret?: string;
    /** Whether webhook requests must present the shared secret */
    webhookRequireSharedSecret: boolean;
    /** Send automatic Telegram notifications for trading cycles */
    telegramNotifyCycleResults: boolean;
    /** Send automatic Telegram notifications when cycles start */
    telegramNotifyCycleStarts: boolean;
    /** Send automatic Telegram notifications for each trade/order event */
    telegramNotifyTradeEvents: boolean;
    /** Send automatic Telegram notifications for fast-cycle skip updates */
    telegramNotifyFastCycleSkips: boolean;
    /** Attach token usage snapshot to Telegram trading updates */
    telegramNotifyTokenUsage: boolean;
    /** Alpaca API Key */
    alpacaApiKey: string;
    /** Alpaca API Secret */
    alpacaApiSecret: string;
    /** Alpaca base URL (paper or live) */
    alpacaBaseUrl: string;
    /** Alpaca market data URL */
    alpacaDataUrl: string;
    /** Allow fractional-share market orders on fractionable Alpaca assets */
    alpacaAllowFractionalShares: boolean;
    /** Hours between autonomous trading cycles */
    tradingCycleHours: number;
    /** Hours between self-reflection cycles */
    reflectionCycleHours: number;
    /** Max tool iterations for autonomous trading cycle */
    tradingMaxToolIterations: number;
    /** Max tool iterations for reflection cycle */
    reflectionMaxToolIterations: number;
    /** Thinking level for autonomous trading cycle */
    tradingThinking: string;
    /** Enable/disable autonomous light cycle */
    lightCycleEnabled: boolean;
    /** Minutes between light cycles during active window */
    lightCycleIntervalMinutes: number;
    /** Enable/disable autonomous ultra-light cycle */
    ultraLightCycleEnabled: boolean;
    /** Minutes between ultra-light cycles during active window */
    ultraLightCycleIntervalMinutes: number;
    /** Optional model override for light-cycle LLM runs */
    lightLlmModel?: string;
    /** Thinking level for light-cycle LLM runs */
    lightLlmThinking: string;
    /** Max tool iterations for light-cycle LLM runs */
    lightLlmMaxToolIterations: number;
    /** Approximate max input tokens budget per light-cycle LLM request */
    lightLlmMaxInputTokens: number;
    /** Max output tokens per light-cycle LLM request */
    lightLlmMaxOutputTokens: number;
    /** Enable deterministic auto-buy fallback if model leaves too much cash idle */
    autoDeployBuysEnabled: boolean;
    /** Max number of fallback buys per trading cycle */
    autoDeployBuysPerCycle: number;
    /** Trigger fallback buys when cash ratio is above this threshold */
    autoDeployCashThreshold: number;
    /** Trigger supplemental fallback buys even after model buys if cash ratio stays above this threshold */
    autoDeployTopUpCashThreshold: number;
    /** Minimum screener score required for deterministic fallback buys */
    autoDeployMinScore: number;
    /** Hard cap for simultaneously open fallback BUY orders */
    autoDeployMaxPendingBuyOrders: number;
    /** Buffer (in bps) above current price for fallback limit buys to improve fill probability */
    autoDeployLimitBufferBps: number;
    /** Hard daily drawdown stop in account currency (e.g. 200 = stop new buys after -200) */
    dailyLossLimitAmount: number;
    /** Minimum daily drawdown stop as fraction of day-start equity (e.g. 0.0075 = 0.75%) */
    dailyLossLimitMinPercent: number;
    /** Timeout for Alpaca HTTP requests in milliseconds */
    alpacaRequestTimeoutMs: number;
    /** Max total runtime for one watchlist screen */
    screenerMaxRuntimeMs: number;
    /** Number of symbols per Alpaca multi-symbol bars request */
    screenerBatchSize: number;
    /** Reject bars older than this many hours */
    maxBarStalenessHours: number;
    /** Rolling 30-day traded volume in USD for dynamic maker/taker fee tiering */
    tradingFee30dVolumeUsd: number;
    /** Enable/disable post-reflection self-improvement pipeline */
    selfImproveEnabled: boolean;
    /** Self-improvement execution mode */
    selfImproveMode: "internal" | "gemini-cli";
    /** Optional model override for internal self-improvement runs */
    selfImproveModel?: string;
    /** Thinking level for internal self-improvement runs */
    selfImproveThinking: string;
    /** Max tool iterations for internal self-improvement runs */
    selfImproveMaxToolIterations: number;
    /** Timeout per self-improvement shell command in milliseconds */
    selfImproveCommandTimeoutMs: number;
    /** Command template used in gemini-cli mode (supports {PROMPT_FILE}) */
    selfImproveGeminiCommand: string;
    /** Mandatory verification/build command after self-improvement */
    selfImproveBuildCommand: string;
    /** Optional additional verification test command */
    selfImproveTestCommand?: string;
    /** Whether to auto-restart the bot after a successful self-improvement */
    selfImproveAutoRestart: boolean;
    /** Command used to start the updated bot */
    selfImproveRestartCommand: string;
    /** Delay before restart command execution */
    selfImproveRestartDelayMs: number;
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        console.error(`❌ Missing required environment variable: ${name}`);
        console.error(`   Copy .env.example to .env and fill in your values.`);
        process.exit(1);
    }
    return value;
}

function optionalEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
}

function parseUserIds(raw: string): number[] {
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
            const n = Number(s);
            if (!Number.isFinite(n)) {
                console.error(`❌ Invalid user ID in ALLOWED_USER_IDS: "${s}"`);
                process.exit(1);
            }
            return n;
        });
}

function parseSelfImproveMode(raw: string | undefined): "internal" | "gemini-cli" {
    const mode = (raw ?? "internal").trim().toLowerCase();
    return mode === "gemini-cli" ? "gemini-cli" : "internal";
}

function parseRuntimeRole(raw: string | undefined): "all" | "main" | "light" | "ultra" {
    const normalized = (raw ?? "all").trim().toLowerCase();
    if (normalized === "main" || normalized === "light" || normalized === "ultra" || normalized === "all") {
        return normalized;
    }
    return "all";
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
    if (raw == null) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
}

function withBudgetDefault(name: string, normalDefault: string, budgetDefault: string, budgetMode: boolean): string {
    return process.env[name] ?? (budgetMode ? budgetDefault : normalDefault);
}

const railwayBudgetMode = parseBooleanEnv(process.env["RAILWAY_BUDGET_MODE"], false);
const runtimeRole = parseRuntimeRole(process.env["TRADING_RUNTIME_ROLE"]);
const defaultTelegramEnabled = runtimeRole === "all" || runtimeRole === "main";
const defaultDailyLogDeliveryEnabled = runtimeRole === "all" || runtimeRole === "main";
const defaultMcpEnabled = runtimeRole === "all" || runtimeRole === "main";
const telegramEnabled = parseBooleanEnv(process.env["TELEGRAM_ENABLED"], defaultTelegramEnabled);
const telegramBotToken = optionalEnv("TELEGRAM_BOT_TOKEN");
const allowedUserIds = optionalEnv("ALLOWED_USER_IDS")
    ? parseUserIds(process.env["ALLOWED_USER_IDS"] as string)
    : [];

export const config: Config = {
    runtimeRole,
    railwayBudgetMode,
    telegramEnabled,
    dailyLogDeliveryEnabled: parseBooleanEnv(process.env["DAILY_LOG_DELIVERY_ENABLED"], defaultDailyLogDeliveryEnabled),
    logToFileEnabled: parseBooleanEnv(withBudgetDefault("LOG_TO_FILE_ENABLED", "true", "false", railwayBudgetMode), !railwayBudgetMode),
    telegramWebhookEnabled: parseBooleanEnv(process.env["TELEGRAM_WEBHOOK_ENABLED"], false),
    telegramWebhookUrl: process.env["TELEGRAM_WEBHOOK_URL"],
    telegramWebhookSecretToken: process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"] ?? process.env["WEBHOOK_SHARED_SECRET"],
    googleDriveLogUploadEnabled: parseBooleanEnv(process.env["GOOGLE_DRIVE_LOG_UPLOAD_ENABLED"], false),
    googleDriveFolderId: process.env["GOOGLE_DRIVE_FOLDER_ID"],
    googleServiceAccountEmail: process.env["GOOGLE_SERVICE_ACCOUNT_EMAIL"],
    googleServiceAccountPrivateKey: process.env["GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"]?.replace(/\\n/g, "\n"),
    deleteLocalLogAfterUpload: parseBooleanEnv(process.env["DELETE_LOCAL_LOG_AFTER_UPLOAD"], true),
    escalationMainUrl: process.env["ESCALATION_MAIN_URL"],
    escalationLightUrl: process.env["ESCALATION_LIGHT_URL"],
    escalationSharedSecret: process.env["ESCALATION_SHARED_SECRET"] ?? process.env["WEBHOOK_SHARED_SECRET"],
    escalationRequestTimeoutMs: Number(process.env["ESCALATION_REQUEST_TIMEOUT_MS"] ?? "8000"),
    telegramBotToken,
    openrouterApiKey: requireEnv("OPENROUTER_API_KEY"),
    openrouterAppTitle: process.env["OPENROUTER_APP_TITLE"] ?? "OpenClaw",
    openrouterAppReferer: process.env["OPENROUTER_APP_REFERER"] ?? "https://openclaw.local",
    allowedUserIds,
    model: process.env["MODEL"] ?? "stepfun/step-3.5-flash:free",
    providerChain: (process.env["PROVIDER_CHAIN"] ?? "openrouter").split(',').map(s => s.trim()).filter(Boolean),
    ollamaHost: process.env["OLLAMA_HOST"],
    maxToolIterations: Number(withBudgetDefault("MAX_TOOL_ITERATIONS", "10", "6", railwayBudgetMode)),
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    elevenlabsApiKey: requireEnv("ELEVENLABS_API_KEY"),
    elevenlabsVoiceId: process.env["ELEVENLABS_VOICE_ID"] ?? "21m00Tcm4TlvDq8ikWAM",
    mcpServersConfigPath: process.env["MCP_SERVERS_CONFIG"],
    mcpEnabled: parseBooleanEnv(process.env["MCP_ENABLED"], defaultMcpEnabled),
    heartbeatEnabled: parseBooleanEnv(withBudgetDefault("HEARTBEAT_ENABLED", "true", "false", railwayBudgetMode), true),
    heartbeatTimezone: process.env["HEARTBEAT_TIMEZONE"] ?? "Europe/Berlin",
    heartbeatIntervalMinutes: Number(process.env["HEARTBEAT_INTERVAL_MINUTES"] ?? "60"),
    marketClosedExitEnabled: parseBooleanEnv(process.env["MARKET_CLOSED_EXIT_ENABLED"], railwayBudgetMode || process.env["NODE_ENV"] === "production"),
    marketClosedExitCheckMinutes: Number(process.env["MARKET_CLOSED_EXIT_CHECK_MINUTES"] ?? "5"),
    webhookPort: Number(process.env["PORT"] ?? process.env["WEBHOOK_PORT"] ?? "3000"),
    webhookJsonLimitKb: Number(process.env["WEBHOOK_JSON_LIMIT_KB"] ?? "32"),
    webhookFormLimitKb: Number(process.env["WEBHOOK_FORM_LIMIT_KB"] ?? "8"),
    webhookRateLimitWindowMs: Number(process.env["WEBHOOK_RATE_LIMIT_WINDOW_MS"] ?? "60000"),
    webhookRateLimitMax: Number(process.env["WEBHOOK_RATE_LIMIT_MAX"] ?? "20"),
    webhookSharedSecret: process.env["WEBHOOK_SHARED_SECRET"],
    webhookRequireSharedSecret: (process.env["WEBHOOK_REQUIRE_SHARED_SECRET"] ?? (process.env["NODE_ENV"] === "production" ? "true" : "false")) === "true",
    telegramNotifyCycleResults: (process.env["TELEGRAM_NOTIFY_CYCLE_RESULTS"] ?? "true") === "true",
    telegramNotifyCycleStarts: (process.env["TELEGRAM_NOTIFY_CYCLE_STARTS"] ?? "true") === "true",
    telegramNotifyTradeEvents: (process.env["TELEGRAM_NOTIFY_TRADE_EVENTS"] ?? "true") === "true",
    telegramNotifyFastCycleSkips: (process.env["TELEGRAM_NOTIFY_FAST_CYCLE_SKIPS"] ?? "true") === "true",
    telegramNotifyTokenUsage: (process.env["TELEGRAM_NOTIFY_TOKEN_USAGE"] ?? "true") === "true",
    alpacaApiKey: requireEnv("ALPACA_API_KEY"),
    alpacaApiSecret: requireEnv("ALPACA_API_SECRET"),
    alpacaBaseUrl: process.env["ALPACA_BASE_URL"] ?? "https://paper-api.alpaca.markets",
    alpacaDataUrl: process.env["ALPACA_DATA_URL"] ?? "https://data.alpaca.markets",
    alpacaAllowFractionalShares: parseBooleanEnv(process.env["ALPACA_ALLOW_FRACTIONAL_SHARES"], false),
    tradingCycleHours: Number(withBudgetDefault("TRADING_CYCLE_HOURS", "1", "1", railwayBudgetMode)),
    reflectionCycleHours: Number(withBudgetDefault("REFLECTION_CYCLE_HOURS", "24", "24", railwayBudgetMode)),
    tradingMaxToolIterations: Number(withBudgetDefault("TRADING_MAX_TOOL_ITERATIONS", "40", "12", railwayBudgetMode)),
    reflectionMaxToolIterations: Number(withBudgetDefault("REFLECTION_MAX_TOOL_ITERATIONS", "8", "4", railwayBudgetMode)),
    tradingThinking: withBudgetDefault("TRADING_THINKING", "medium", "off", railwayBudgetMode),
    lightCycleEnabled: parseBooleanEnv(withBudgetDefault("LIGHT_CYCLE_ENABLED", "true", "true", railwayBudgetMode), true),
    lightCycleIntervalMinutes: Number(withBudgetDefault("LIGHT_CYCLE_INTERVAL_MINUTES", "5", "5", railwayBudgetMode)),
    ultraLightCycleEnabled: parseBooleanEnv(withBudgetDefault("ULTRA_LIGHT_CYCLE_ENABLED", "true", "true", railwayBudgetMode), true),
    ultraLightCycleIntervalMinutes: Number(withBudgetDefault("ULTRA_LIGHT_CYCLE_INTERVAL_MINUTES", "1", "1", railwayBudgetMode)),
    lightLlmModel: process.env["LIGHT_LLM_MODEL"],
    lightLlmThinking: withBudgetDefault("LIGHT_LLM_THINKING", "off", "off", railwayBudgetMode),
    lightLlmMaxToolIterations: Number(withBudgetDefault("LIGHT_LLM_MAX_TOOL_ITERATIONS", "5", "3", railwayBudgetMode)),
    lightLlmMaxInputTokens: Number(withBudgetDefault("LIGHT_LLM_MAX_INPUT_TOKENS", "10000", "3000", railwayBudgetMode)),
    lightLlmMaxOutputTokens: Number(withBudgetDefault("LIGHT_LLM_MAX_OUTPUT_TOKENS", "800", "300", railwayBudgetMode)),
    autoDeployBuysEnabled: parseBooleanEnv(withBudgetDefault("AUTO_DEPLOY_BUYS_ENABLED", "true", "false", railwayBudgetMode), true),
    autoDeployBuysPerCycle: Number(process.env["AUTO_DEPLOY_BUYS_PER_CYCLE"] ?? "2"),
    autoDeployCashThreshold: Number(process.env["AUTO_DEPLOY_CASH_THRESHOLD"] ?? "0.40"),
    autoDeployTopUpCashThreshold: Number(process.env["AUTO_DEPLOY_TOPUP_CASH_THRESHOLD"] ?? "0.55"),
    autoDeployMinScore: Number(process.env["AUTO_DEPLOY_MIN_SCORE"] ?? "4"),
    autoDeployMaxPendingBuyOrders: Number(process.env["AUTO_DEPLOY_MAX_PENDING_BUY_ORDERS"] ?? "3"),
    autoDeployLimitBufferBps: Number(process.env["AUTO_DEPLOY_LIMIT_BUFFER_BPS"] ?? "25"),
    dailyLossLimitAmount: Number(process.env["DAILY_LOSS_LIMIT_AMOUNT"] ?? "200"),
    dailyLossLimitMinPercent: Number(process.env["DAILY_LOSS_LIMIT_MIN_PERCENT"] ?? "0.0075"),
    alpacaRequestTimeoutMs: Number(process.env["ALPACA_REQUEST_TIMEOUT_MS"] ?? "12000"),
    screenerMaxRuntimeMs: Number(process.env["SCREENER_MAX_RUNTIME_MS"] ?? "90000"),
    screenerBatchSize: Number(process.env["SCREENER_BATCH_SIZE"] ?? "80"),
    maxBarStalenessHours: Number(process.env["MAX_BAR_STALENESS_HOURS"] ?? "120"),
    tradingFee30dVolumeUsd: Number(process.env["TRADING_FEE_30D_VOLUME_USD"] ?? "0"),
    selfImproveEnabled: (process.env["SELF_IMPROVE_ENABLED"] ?? "false") === "true",
    selfImproveMode: parseSelfImproveMode(process.env["SELF_IMPROVE_MODE"]),
    selfImproveModel: process.env["SELF_IMPROVE_MODEL"],
    selfImproveThinking: process.env["SELF_IMPROVE_THINKING"] ?? "medium",
    selfImproveMaxToolIterations: Number(process.env["SELF_IMPROVE_MAX_TOOL_ITERATIONS"] ?? "16"),
    selfImproveCommandTimeoutMs: Number(process.env["SELF_IMPROVE_COMMAND_TIMEOUT_MS"] ?? "900000"),
    selfImproveGeminiCommand: process.env["SELF_IMPROVE_GEMINI_COMMAND"] ?? "",
    selfImproveBuildCommand: process.env["SELF_IMPROVE_BUILD_COMMAND"] ?? "npm run build",
    selfImproveTestCommand: process.env["SELF_IMPROVE_TEST_COMMAND"],
    selfImproveAutoRestart: (process.env["SELF_IMPROVE_AUTO_RESTART"] ?? "false") === "true",
    selfImproveRestartCommand: process.env["SELF_IMPROVE_RESTART_COMMAND"] ?? "npm start",
    selfImproveRestartDelayMs: Number(process.env["SELF_IMPROVE_RESTART_DELAY_MS"] ?? "12000"),
};

if (config.telegramEnabled) {
    if (!config.telegramBotToken) {
        console.error(`âŒ Missing required environment variable: TELEGRAM_BOT_TOKEN`);
        console.error(`   Copy .env.example to .env and fill in your values.`);
        process.exit(1);
    }
    if (config.allowedUserIds.length === 0) {
        console.error(`âŒ Missing required environment variable: ALLOWED_USER_IDS`);
        console.error(`   Copy .env.example to .env and fill in your values.`);
        process.exit(1);
    }
}
