import fs from "fs";
import path from "path";
import util from "node:util";
import { bot } from "./bot.js";
import { config } from "./config.js";
import cron from "node-cron";
import { InputFile } from "grammy";
import type { ScheduledTask } from "node-cron";

const LOGS_DIR = path.join(process.cwd(), "logs");
let dailyLogJob: ScheduledTask | null = null;
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function getLogFileName(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}.log`;
}

/**
 * Enhanced logger that writes to files and sends errors to Telegram
 */
export const logger = {
    info: (msg: string) => writeLog(msg, "INFO"),
    warn: (msg: string) => writeLog(msg, "WARN"),
    error: (msg: string, error?: any) => {
        let fullMsg = msg;
        if (error) {
            fullMsg += ` | Error: ${error.message || error}`;
            if (error.stack) fullMsg += `\nStack: ${error.stack}`;
        }
        writeLog(fullMsg, "ERROR");
    }
};

function writeLog(message: string, level: "INFO" | "ERROR" | "WARN") {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${level}] ${message}`;
    
    // Print to original console
    if (level === "ERROR") {
        process.stderr.write(formattedMessage + "\n");
    } else {
        process.stdout.write(formattedMessage + "\n");
    }

    // Write to file
    const logFile = path.join(LOGS_DIR, getLogFileName());
    try {
        fs.appendFileSync(logFile, formattedMessage + "\n");
    } catch (err) {
        process.stderr.write(`Failed to write to log file: ${err}\n`);
    }

    // If it's an error, notify via Telegram
    if (level === "ERROR") {
        sendErrorToAdmin(formattedMessage).catch(err => {
            process.stderr.write(`Failed to send error notification to Telegram: ${err.message}\n`);
        });
    }
}

async function sendErrorToAdmin(message: string) {
    const adminId = config.allowedUserIds[0];
    if (adminId) {
        try {
            // Truncate message if too long for Telegram (4096 chars)
            const text = message.length > 4000 ? message.substring(0, 3900) + "..." : message;
            await bot.api.sendMessage(adminId, `🚨 *SYSTEM ERROR ALERT* 🚨\n\n\`\`\`\n${text}\n\`\`\``, {
                parse_mode: "Markdown"
            });
        } catch (e) {
            process.stderr.write(`Telegram error report failed: ${e}\n`);
        }
    }
}

/**
 * Sets up a cron job to send the previous day's log file every morning
 */
export function setupDailyLogDelivery() {
    if (dailyLogJob) {
        logger.info("Daily log delivery already scheduled. Skipping duplicate setup.");
        return;
    }
    // Schedule daily at 00:05 to send the logs of the day that just ended
    dailyLogJob = cron.schedule("5 0 * * *", async () => {
        const adminId = config.allowedUserIds[0];
        if (!adminId) return;

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const fileName = getLogFileName(yesterday);
        const logFile = path.join(LOGS_DIR, fileName);

        if (fs.existsSync(logFile)) {
            try {
                await bot.api.sendDocument(adminId, new InputFile(logFile), {
                    caption: `📅 Daily Log File: ${fileName}`
                });
                logger.info(`Daily log file (${fileName}) sent to admin.`);
            } catch (err: any) {
                // Use process.stderr directly to avoid potential recursion if logger.error fails
                process.stderr.write(`Failed to send daily log file: ${err.message}\n`);
            }
        } else {
            logger.info(`No log file found for yesterday (${fileName}).`);
        }
    });
    
    logger.info("Daily log delivery scheduled for 00:05.");
}

export function stopDailyLogDelivery() {
    if (!dailyLogJob) return;
    dailyLogJob.stop();
    dailyLogJob = null;
    logger.info("Daily log delivery stopped.");
}

function formatLogArg(value: any): string {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || value.message || String(value);
    if (typeof value === "object" && value !== null) {
        try {
            return JSON.stringify(value);
        } catch {
            return util.inspect(value, {
                depth: 3,
                breakLength: 140,
                maxArrayLength: 20,
                maxStringLength: 400,
            });
        }
    }
    return String(value);
}

// Optional: Override global console to catch all logs from dependencies
export function overrideConsole() {
    console.log = (...args: any[]) => logger.info(args.map(formatLogArg).join(" "));
    console.error = (...args: any[]) => logger.error(args.map(formatLogArg).join(" "));
    console.warn = (...args: any[]) => logger.warn(args.map(formatLogArg).join(" "));
}
