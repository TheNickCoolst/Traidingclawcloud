import fs from "fs";
import path from "path";
import util from "node:util";
import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { config } from "./config.js";
import { router } from "./channels/router.js";

const LOGS_DIR = path.join(process.cwd(), "logs");
let dailyLogJob: ScheduledTask | null = null;

if (config.logToFileEnabled && !fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function getLogFileName(date = new Date()): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}.log`;
}

/**
 * Enhanced logger that writes to stdout/stderr and optionally to log files.
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
    },
};

function writeLog(message: string, level: "INFO" | "ERROR" | "WARN"): void {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${level}] ${message}`;

    if (level === "ERROR") {
        process.stderr.write(formattedMessage + "\n");
    } else {
        process.stdout.write(formattedMessage + "\n");
    }

    if (config.logToFileEnabled) {
        const logFile = path.join(LOGS_DIR, getLogFileName());
        try {
            fs.appendFileSync(logFile, formattedMessage + "\n");
        } catch (err) {
            process.stderr.write(`Failed to write to log file: ${err}\n`);
        }
    }

    if (level === "ERROR" && config.telegramEnabled) {
        sendErrorToAdmin(formattedMessage).catch((err) => {
            process.stderr.write(`Failed to send error notification to Telegram: ${err.message}\n`);
        });
    }
}

async function sendErrorToAdmin(message: string): Promise<void> {
    const adminId = config.allowedUserIds[0];
    if (!adminId) return;

    try {
        const text = message.length > 4000 ? message.substring(0, 3900) + "..." : message;
        await router.send("telegram", {
            chatId: adminId,
            userId: adminId,
            text: `SYSTEM ERROR ALERT\n\n${text}`,
        });
    } catch (e) {
        process.stderr.write(`Telegram error report failed: ${e}\n`);
    }
}

async function uploadLogToGoogleDrive(logFile: string, fileName: string): Promise<void> {
    if (!config.googleDriveLogUploadEnabled) return;

    const email = config.googleServiceAccountEmail?.trim();
    const privateKey = config.googleServiceAccountPrivateKey;
    if (!email || !privateKey) {
        process.stderr.write("Google Drive upload enabled but service-account credentials are missing.\n");
        return;
    }

    try {
        const { google } = await import("googleapis");
        const auth = new google.auth.JWT({
            email,
            key: privateKey,
            scopes: ["https://www.googleapis.com/auth/drive.file"],
        });
        const drive = google.drive({ version: "v3", auth });
        const folderId = config.googleDriveFolderId?.trim();

        const requestBody: { name: string; parents?: string[] } = { name: fileName };
        if (folderId) {
            requestBody.parents = [folderId];
        }

        const upload = await drive.files.create({
            requestBody,
            media: {
                mimeType: "text/plain",
                body: fs.createReadStream(logFile),
            },
            fields: "id,name,webViewLink",
        });

        process.stdout.write(`[GoogleDrive] Uploaded ${fileName} (id=${upload.data.id ?? "unknown"}).\n`);

        if (config.deleteLocalLogAfterUpload) {
            try {
                fs.unlinkSync(logFile);
                process.stdout.write(`[GoogleDrive] Deleted local log file: ${fileName}\n`);
            } catch (err: any) {
                process.stderr.write(`[GoogleDrive] Failed to delete ${fileName}: ${err.message}\n`);
            }
        }
    } catch (err: any) {
        process.stderr.write(`[GoogleDrive] Upload failed for ${fileName}: ${err.message}\n`);
    }
}

/**
 * Schedule daily log delivery/upload at 00:05.
 */
export function setupDailyLogDelivery(): void {
    if (!config.dailyLogDeliveryEnabled) {
        logger.info("Daily log delivery disabled for this runtime role.");
        return;
    }
    if (!config.logToFileEnabled) {
        logger.info("Daily log delivery disabled because LOG_TO_FILE is disabled.");
        return;
    }
    if (dailyLogJob) {
        logger.info("Daily log delivery already scheduled. Skipping duplicate setup.");
        return;
    }

    dailyLogJob = cron.schedule("5 0 * * *", async () => {
        const adminId = config.allowedUserIds[0];
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const fileName = getLogFileName(yesterday);
        const logFile = path.join(LOGS_DIR, fileName);

        if (!fs.existsSync(logFile)) {
            logger.info(`No log file found for yesterday (${fileName}).`);
            return;
        }

        try {
            if (config.telegramEnabled && adminId) {
                // Lazy import so non-Telegram/low-memory runtimes don't load grammy stack.
                const [{ bot }, { InputFile }] = await Promise.all([
                    import("./bot.js"),
                    import("grammy"),
                ]);
                await bot.api.sendDocument(adminId, new InputFile(logFile), {
                    caption: `Daily Log File: ${fileName}`,
                });
                logger.info(`Daily log file (${fileName}) sent to admin.`);
            }

            await uploadLogToGoogleDrive(logFile, fileName);
        } catch (err: any) {
            process.stderr.write(`Failed to deliver daily log file: ${err.message}\n`);
        }
    });

    logger.info("Daily log delivery scheduled for 00:05.");
}

export function stopDailyLogDelivery(): void {
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

export function overrideConsole(): void {
    console.log = (...args: any[]) => logger.info(args.map(formatLogArg).join(" "));
    console.error = (...args: any[]) => logger.error(args.map(formatLogArg).join(" "));
    console.warn = (...args: any[]) => logger.warn(args.map(formatLogArg).join(" "));
}
