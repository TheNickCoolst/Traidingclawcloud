import { exec, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { config } from "../config.js";
import { AgentLoop } from "../agent/loop.js";

const execAsync = promisify(exec);
const SELF_IMPROVE_DIR = path.join(process.cwd(), "data", "self-improve");
const MAX_COMMAND_OUTPUT_CHARS = 3500;
let restartAlreadyQueued = false;

export interface SelfImproveContext {
    reflectionText: string;
    periodStartIso: string;
    periodEndIso: string;
    totalTrades: number;
    totalPnl: number;
}

export interface SelfImproveResult {
    attempted: boolean;
    mode: "internal" | "gemini-cli";
    success: boolean;
    summary: string;
    restartQueued: boolean;
}

interface ShellRunResult {
    ok: boolean;
    output: string;
}

interface RestartQueueResult {
    queued: boolean;
    message: string;
}

const INTERNAL_SELF_IMPROVE_SYSTEM_PROMPT = `You are TradingClaw's internal self-improvement engineer.
Your job is to improve expected risk-adjusted trading performance while keeping all hard risk constraints intact.

MANDATORY GUARDRAILS (MUST NOT BE BROKEN):
- Position risk remains 2% of equity (ATR-based sizing).
- Max 7 open positions.
- Max 2 positions per sector.
- Cash utilization target remains >= 60% invested (if cash > 40%, seek buys unless loss guard is active).
- Entry threshold remains score >= 3/6.
- Buy entries remain LIMIT orders around +0.2% over current price.
- Every buy keeps immediate downside protection (trailing stop / stop) and +10% take-profit.
- Break-even logic at +3%, tightened stop at +5%, hard floor stop-loss around -7%.

EXECUTION RULES:
- Use tools to inspect and edit local files.
- Keep edits focused and minimal.
- Do not remove safety checks.
- Run verification commands from shell and ensure they pass.

FINAL OUTPUT FORMAT (STRICT):
STATUS: SUCCESS|FAILED
CHANGED_FILES:
- path
RATIONALE:
- concise bullets
VALIDATION:
- commands run + pass/fail
`;

function toPositiveInt(value: number, fallback: number): number {
    const n = Math.floor(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ensureSelfImproveDir(): void {
    if (!fs.existsSync(SELF_IMPROVE_DIR)) {
        fs.mkdirSync(SELF_IMPROVE_DIR, { recursive: true });
    }
}

function clip(text: string, maxChars: number = MAX_COMMAND_OUTPUT_CHARS): string {
    const normalized = (text || "").trim();
    if (!normalized) return "(no output)";
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars)}\n...[truncated]`;
}

function asText(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    return String(value);
}

async function runCommand(command: string, timeoutMs: number): Promise<ShellRunResult> {
    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd: process.cwd(),
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
        });
        const output = [stdout, stderr ? `[STDERR]\n${stderr}` : ""].filter(Boolean).join("\n");
        return { ok: true, output: clip(output) };
    } catch (err: any) {
        const stdout = asText(err?.stdout);
        const stderr = asText(err?.stderr);
        const message = asText(err?.message);
        const output = [
            `Command failed: ${message}`,
            stdout ? `[STDOUT]\n${stdout}` : "",
            stderr ? `[STDERR]\n${stderr}` : "",
        ].filter(Boolean).join("\n");
        return { ok: false, output: clip(output) };
    }
}

function buildSelfImprovePrompt(context: SelfImproveContext): string {
    const clippedReflection = context.reflectionText.slice(0, 6000);
    const testHint = config.selfImproveTestCommand?.trim()
        ? `Then run: ${config.selfImproveTestCommand.trim()}`
        : "No additional test command is configured; rely on build verification.";

    return [
        `Improve TradingClaw after reflection window ${context.periodStartIso} -> ${context.periodEndIso}.`,
        `Last 24h trade count: ${context.totalTrades}, current open-position P/L sum: ${context.totalPnl.toFixed(2)}.`,
        "",
        "Objective:",
        "- Increase expected profitability while preserving strict risk controls and non-destructive behavior.",
        "- Prefer changes in strategy/execution quality, error handling, and safer order management.",
        "",
        "Required verification:",
        `- Run: ${config.selfImproveBuildCommand}`,
        `- ${testHint}`,
        "",
        "Reflection text:",
        clippedReflection,
        "",
        "Apply changes directly in this repository and return the strict output format.",
    ].join("\n");
}

async function runInternalSelfImprove(context: SelfImproveContext): Promise<ShellRunResult> {
    const prompt = buildSelfImprovePrompt(context);
    const history: ChatCompletionMessageParam[] = [{ role: "user", content: prompt }];
    const loop = new AgentLoop(toPositiveInt(config.selfImproveMaxToolIterations, 16));

    try {
        const result = await loop.run(
            history,
            INTERNAL_SELF_IMPROVE_SYSTEM_PROMPT,
            config.selfImproveThinking || "medium",
            {
                allowedToolNames: ["read_file", "write_file", "list_directory", "execute_shell"],
                modelOverride: config.selfImproveModel?.trim() || undefined,
                maxTokens: 1600,
            }
        );
        return { ok: true, output: clip(result, 4000) };
    } catch (err: any) {
        return { ok: false, output: `Internal self-improve loop failed: ${asText(err?.message)}` };
    }
}

function buildGeminiCommand(promptFilePath: string): string {
    const template = config.selfImproveGeminiCommand.trim();
    if (!template) {
        throw new Error("SELF_IMPROVE_GEMINI_COMMAND is empty.");
    }

    const quotedPath = JSON.stringify(promptFilePath);
    if (template.includes("{PROMPT_FILE}")) {
        return template.replace(/\{PROMPT_FILE\}/g, quotedPath);
    }

    return `${template} ${quotedPath}`;
}

async function runGeminiCliSelfImprove(context: SelfImproveContext): Promise<ShellRunResult> {
    ensureSelfImproveDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const promptPath = path.join(SELF_IMPROVE_DIR, `gemini-prompt-${timestamp}.md`);
    fs.writeFileSync(promptPath, buildSelfImprovePrompt(context), "utf-8");

    let command: string;
    try {
        command = buildGeminiCommand(promptPath);
    } catch (err: any) {
        return { ok: false, output: `Gemini mode setup failed: ${asText(err?.message)}` };
    }

    const run = await runCommand(command, toPositiveInt(config.selfImproveCommandTimeoutMs, 900000));
    const combined = `Gemini command: ${command}\n\n${run.output}`;
    return { ok: run.ok, output: clip(combined, 4500) };
}

async function runVerification(): Promise<ShellRunResult> {
    const timeoutMs = toPositiveInt(config.selfImproveCommandTimeoutMs, 900000);
    const commands = [
        config.selfImproveBuildCommand.trim(),
        (config.selfImproveTestCommand ?? "").trim(),
    ].filter(Boolean);

    if (commands.length === 0) {
        return { ok: false, output: "Verification skipped: no commands configured." };
    }

    const details: string[] = [];
    for (const command of commands) {
        const result = await runCommand(command, timeoutMs);
        details.push(`${result.ok ? "✅" : "❌"} ${command}\n${result.output}`);
        if (!result.ok) {
            return { ok: false, output: details.join("\n\n") };
        }
    }

    return { ok: true, output: details.join("\n\n") };
}

function queueRestart(): RestartQueueResult {
    if (!config.selfImproveAutoRestart) {
        return {
            queued: false,
            message: "Auto-restart disabled (SELF_IMPROVE_AUTO_RESTART=false).",
        };
    }
    if (restartAlreadyQueued) {
        return { queued: true, message: "Restart is already queued." };
    }

    const restartCommand = config.selfImproveRestartCommand.trim();
    if (!restartCommand) {
        return {
            queued: false,
            message: "Auto-restart enabled, but SELF_IMPROVE_RESTART_COMMAND is empty.",
        };
    }

    const delayMs = Math.max(10000, toPositiveInt(config.selfImproveRestartDelayMs, 12000));
    const exitDelayMs = Math.max(1500, delayMs - 2000);
    const bootstrap = [
        "const { exec } = require('child_process');",
        `const command = ${JSON.stringify(restartCommand)};`,
        `const cwd = ${JSON.stringify(process.cwd())};`,
        `setTimeout(() => exec(command, { cwd, windowsHide: true }, () => {}), ${delayMs});`,
    ].join("\n");

    try {
        const child = spawn(process.execPath, ["-e", bootstrap], {
            cwd: process.cwd(),
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        });
        child.unref();
        restartAlreadyQueued = true;

        setTimeout(() => {
            process.exit(0);
        }, exitDelayMs).unref();

        return {
            queued: true,
            message: `Restart queued: "${restartCommand}" in ~${Math.round(delayMs / 1000)}s. Current process exits in ~${Math.round(exitDelayMs / 1000)}s.`,
        };
    } catch (err: any) {
        restartAlreadyQueued = false;
        return {
            queued: false,
            message: `Failed to queue restart: ${asText(err?.message)}`,
        };
    }
}

function persistRunLog(summary: string): void {
    ensureSelfImproveDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(SELF_IMPROVE_DIR, `run-${timestamp}.log`);
    fs.writeFileSync(file, summary, "utf-8");
}

export async function runSelfImproveCycle(context: SelfImproveContext): Promise<SelfImproveResult> {
    if (!config.selfImproveEnabled) {
        return {
            attempted: false,
            mode: config.selfImproveMode,
            success: false,
            summary: "Self-improvement is disabled (SELF_IMPROVE_ENABLED=false).",
            restartQueued: false,
        };
    }

    const mode = config.selfImproveMode;
    const execution = mode === "gemini-cli"
        ? await runGeminiCliSelfImprove(context)
        : await runInternalSelfImprove(context);

    const verification = execution.ok
        ? await runVerification()
        : { ok: false, output: "Verification skipped because self-improvement execution failed." };

    const success = execution.ok && verification.ok;
    const restartResult = success
        ? queueRestart()
        : { queued: false, message: "Restart skipped (self-improvement or verification failed)." };

    const summaryLines = [
        `🛠️ SELF-IMPROVE MODE: ${mode}`,
        execution.ok ? "✅ Improvement step completed." : "❌ Improvement step failed.",
        success ? "✅ Verification passed." : "❌ Verification failed.",
        "",
        "Execution output:",
        execution.output,
        "",
        "Verification output:",
        verification.output,
        "",
        `Restart: ${restartResult.message}`,
    ];

    const summary = summaryLines.join("\n");
    persistRunLog(summary);

    return {
        attempted: true,
        mode,
        success,
        summary,
        restartQueued: restartResult.queued,
    };
}
