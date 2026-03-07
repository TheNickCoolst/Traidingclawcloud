import "dotenv/config";

interface Config {
    /** Telegram bot token from BotFather */
    telegramBotToken: string;
    /** OpenRouter API key */
    openrouterApiKey: string;
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
    /** Whether the heartbeat scheduler is enabled */
    heartbeatEnabled: boolean;
    /** Timezone for heartbeat schedule (IANA format) */
    heartbeatTimezone: string;
    /** Background monologue interval in minutes */
    heartbeatIntervalMinutes: number;
    /** Alpaca API Key */
    alpacaApiKey: string;
    /** Alpaca API Secret */
    alpacaApiSecret: string;
    /** Alpaca base URL (paper or live) */
    alpacaBaseUrl: string;
    /** Alpaca market data URL */
    alpacaDataUrl: string;
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

export const config: Config = {
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    openrouterApiKey: requireEnv("OPENROUTER_API_KEY"),
    allowedUserIds: parseUserIds(requireEnv("ALLOWED_USER_IDS")),
    model: process.env["MODEL"] ?? "stepfun/step-3.5-flash:free",
    providerChain: (process.env["PROVIDER_CHAIN"] ?? "openrouter").split(',').map(s => s.trim()).filter(Boolean),
    ollamaHost: process.env["OLLAMA_HOST"],
    maxToolIterations: Number(process.env["MAX_TOOL_ITERATIONS"] ?? "10"),
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    elevenlabsApiKey: requireEnv("ELEVENLABS_API_KEY"),
    elevenlabsVoiceId: process.env["ELEVENLABS_VOICE_ID"] ?? "21m00Tcm4TlvDq8ikWAM",
    mcpServersConfigPath: process.env["MCP_SERVERS_CONFIG"],
    heartbeatEnabled: (process.env["HEARTBEAT_ENABLED"] ?? "true") === "true",
    heartbeatTimezone: process.env["HEARTBEAT_TIMEZONE"] ?? "Europe/Berlin",
    heartbeatIntervalMinutes: Number(process.env["HEARTBEAT_INTERVAL_MINUTES"] ?? "60"),
    alpacaApiKey: requireEnv("ALPACA_API_KEY"),
    alpacaApiSecret: requireEnv("ALPACA_API_SECRET"),
    alpacaBaseUrl: process.env["ALPACA_BASE_URL"] ?? "https://paper-api.alpaca.markets",
    alpacaDataUrl: process.env["ALPACA_DATA_URL"] ?? "https://data.alpaca.markets",
    tradingCycleHours: Number(process.env["TRADING_CYCLE_HOURS"] ?? "3"),
    reflectionCycleHours: Number(process.env["REFLECTION_CYCLE_HOURS"] ?? "24"),
    tradingMaxToolIterations: Number(process.env["TRADING_MAX_TOOL_ITERATIONS"] ?? "40"),
    reflectionMaxToolIterations: Number(process.env["REFLECTION_MAX_TOOL_ITERATIONS"] ?? "8"),
    tradingThinking: process.env["TRADING_THINKING"] ?? "medium",
    lightCycleEnabled: (process.env["LIGHT_CYCLE_ENABLED"] ?? "true") === "true",
    lightCycleIntervalMinutes: Number(process.env["LIGHT_CYCLE_INTERVAL_MINUTES"] ?? "1"),
    ultraLightCycleEnabled: (process.env["ULTRA_LIGHT_CYCLE_ENABLED"] ?? "true") === "true",
    ultraLightCycleIntervalMinutes: Number(process.env["ULTRA_LIGHT_CYCLE_INTERVAL_MINUTES"] ?? "1"),
    lightLlmModel: process.env["LIGHT_LLM_MODEL"],
    lightLlmThinking: process.env["LIGHT_LLM_THINKING"] ?? "off",
    lightLlmMaxToolIterations: Number(process.env["LIGHT_LLM_MAX_TOOL_ITERATIONS"] ?? "5"),
    lightLlmMaxInputTokens: Number(process.env["LIGHT_LLM_MAX_INPUT_TOKENS"] ?? "10000"),
    lightLlmMaxOutputTokens: Number(process.env["LIGHT_LLM_MAX_OUTPUT_TOKENS"] ?? "800"),
    autoDeployBuysEnabled: (process.env["AUTO_DEPLOY_BUYS_ENABLED"] ?? "true") === "true",
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
