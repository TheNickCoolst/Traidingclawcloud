import { Bot, InputFile } from "grammy";
import { config } from "./config.js";
import { clearHistory } from "./agent.js";
import { pruneContext } from "./memory/pruning.js";
import { transcribeAudio, generateSpeech } from "./voice.js";
import { router, Channel, RouterMessage } from "./channels/router.js";
import { extractAndStoreImageIntelligence } from "./memory/multimodal.js";
import { getTradingStatus, manualTradingCycle, manualReflectionCycle } from "./trading/engine.js";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";

// Ensure tmp directory exists for downloading voice messages
const tmpDir = path.join(process.cwd(), "tmp");
if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
}

export const bot = new Bot(config.telegramBotToken);

// ── Security middleware: whitelist check ──────────────────────────
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;

    // Silently ignore unauthorized users
    if (!userId || !config.allowedUserIds.includes(userId)) {
        return;
    }

    await next();
});

// ── /start command ───────────────────────────────────────────────
bot.command("start", async (ctx) => {
    await ctx.reply(
        "📈 *TradingClaw v3.0 — Trading Bot*\\n\\n" +
        "I'm your autonomous stock trading bot running on Alpaca paper trading.\\n\\n" +
        "Commands:\\n" +
        "/status — View trading status & positions\\n" +
        "/trade — Manually trigger a trading cycle\\n" +
        "/reflect — Manually trigger a reflection cycle\\n" +
        "/usage — View LLM API token usage stats\\n" +
        "/new — Start a fresh conversation\\n" +
        "/ping — Check if I'm alive",
        { parse_mode: "Markdown" }
    );
});

// ── /status command — show trading status ────────────────────────
bot.command("status", async (ctx) => {
    let typingInterval: NodeJS.Timeout | null = null;

    try {
        typingInterval = setInterval(() => ctx.replyWithChatAction("typing").catch(() => { }), 4000);
        await ctx.replyWithChatAction("typing");

        const status = await getTradingStatus();
        await ctx.reply(status);
    } catch (err: any) {
        await ctx.reply(`⚠️ Error getting status: ${err.message}`);
    } finally {
        if (typingInterval) clearInterval(typingInterval);
    }
});

// ── /trade command — manually trigger trading cycle ──────────────
bot.command("trade", async (ctx) => {
    await ctx.reply("🔄 Starting manual trading cycle...");

    // Run in the background so Telegram doesn't retry the webhook/poll on slow responses
    (async () => {
        let typingInterval: NodeJS.Timeout | null = null;
        try {
            const chatId = ctx.chat.id;
            typingInterval = setInterval(() => bot.api.sendChatAction(chatId, "typing").catch(() => { }), 4000);
            await bot.api.sendChatAction(chatId, "typing");

            const result = await manualTradingCycle();

            // Split result if too long
            if (result.length <= 4000) {
                await bot.api.sendMessage(chatId, result);
            } else {
                await bot.api.sendMessage(chatId, result.slice(0, 4000) + "\\n\\n[...truncated]");
            }
        } catch (err: any) {
            await bot.api.sendMessage(ctx.chat.id, `⚠️ Trading cycle failed: ${err.message}`);
        } finally {
            if (typingInterval) clearInterval(typingInterval);
        }
    })();
});

// ── /reflect command — manually trigger reflection cycle ─────────
bot.command("reflect", async (ctx) => {
    await ctx.reply("🧠 Starting manual reflection cycle...");

    (async () => {
        let typingInterval: NodeJS.Timeout | null = null;
        try {
            const chatId = ctx.chat.id;
            typingInterval = setInterval(() => bot.api.sendChatAction(chatId, "typing").catch(() => { }), 4000);
            await bot.api.sendChatAction(chatId, "typing");

            const result = await manualReflectionCycle();

            if (result.length <= 4000) {
                await bot.api.sendMessage(chatId, result);
            } else {
                await bot.api.sendMessage(chatId, result.slice(0, 4000) + "\\n\\n[...truncated]");
            }
        } catch (err: any) {
            await bot.api.sendMessage(ctx.chat.id, `⚠️ Reflection cycle failed: ${err.message}`);
        } finally {
            if (typingInterval) clearInterval(typingInterval);
        }
    })();
});

// ── /new command — clear conversation history ────────────────────
bot.command("new", async (ctx) => {
    clearHistory(ctx.chat.id);
    await ctx.reply("🧹 Conversation cleared. Fresh start!");
});

// ── /compact command — manually trigger memory pruning ────────────
bot.command("compact", async (ctx) => {
    let typingInterval: NodeJS.Timeout | null = null;

    try {
        typingInterval = setInterval(() => ctx.replyWithChatAction("typing").catch(() => { }), 4000);
        await ctx.replyWithChatAction("typing");

        const sessionId = `telegram_${ctx.chat.id}`;
        const success = await pruneContext(sessionId);

        if (success) {
            await ctx.reply("🧠 Successfully compacted your conversation history into a dense summary.");
        } else {
            await ctx.reply("ℹ️ History is too short to compact or an error occurred.");
        }
    } finally {
        if (typingInterval) clearInterval(typingInterval);
    }
});

// ── /usage command — view API token consumption ────────────────────
bot.command("usage", async (ctx) => {
    let typingInterval: NodeJS.Timeout | null = null;
    try {
        typingInterval = setInterval(() => ctx.replyWithChatAction("typing").catch(() => { }), 4000);
        await ctx.replyWithChatAction("typing");

        // Dynamically import to avoid circular dependencies during initialization
        const { getTokenUsageStats } = await import("./db.js");
        const stats = getTokenUsageStats();

        const msg = [
            "📊 **LLM Token Usage limits & stats**",
            "",
            `• **1 Hour**: 📥 ${stats['1h_prompt'].toLocaleString()} IN | 📤 ${stats['1h_comp'].toLocaleString()} OUT (${stats['1h_req']} calls)`,
            `• **3 Hours**: 📥 ${stats['3h_prompt'].toLocaleString()} IN | 📤 ${stats['3h_comp'].toLocaleString()} OUT (${stats['3h_req']} calls)`,
            `• **24 Hours**: 📥 ${stats['24h_prompt'].toLocaleString()} IN | 📤 ${stats['24h_comp'].toLocaleString()} OUT (${stats['24h_req']} calls)`,
            `• **7 Days**: 📥 ${stats['7d_prompt'].toLocaleString()} IN | 📤 ${stats['7d_comp'].toLocaleString()} OUT (${stats['7d_req']} calls)`,
            `• **30 Days**: 📥 ${stats['30d_prompt'].toLocaleString()} IN | 📤 ${stats['30d_comp'].toLocaleString()} OUT (${stats['30d_req']} calls)`,
            `• **Total**: 📥 ${stats['all_prompt'].toLocaleString()} IN | 📤 ${stats['all_comp'].toLocaleString()} OUT (${stats['all_req']} calls)`,
            "",
            "*(Usage tracks all models across all loaded API keys)*"
        ].join("\n");

        await ctx.reply(msg, { parse_mode: "Markdown" });
    } catch (err: any) {
        await ctx.reply(`⚠️ Failed to load usage statistics: ${err.message}`);
    } finally {
        if (typingInterval) clearInterval(typingInterval);
    }
});

// ── /ping command ────────────────────────────────────────────────
bot.command("ping", async (ctx) => {
    await ctx.reply("🏓 Pong! TradingClaw is alive and trading.");
});

// ── /logs command ────────────────────────────────────────────────
bot.command("logs", async (ctx) => {
    const logFile = path.join(process.cwd(), "logs", `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}.log`);
    if (fs.existsSync(logFile)) {
        await ctx.replyWithDocument(new InputFile(logFile), {
            caption: "📄 Current session logs"
        });
    } else {
        await ctx.reply("ℹ️ No log file found for today yet.");
    }
});

// ── Message handler — route to central bus ────────────────────────
bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (!text) return;

    // Show continuous "typing" indicator while the agentic loop processes tools
    let typingInterval: NodeJS.Timeout | null = null;

    try {
        console.log(`📩 [${ctx.from.first_name}] ${text}`);

        typingInterval = setInterval(() => {
            ctx.replyWithChatAction("typing").catch(() => { });
        }, 4000); // Telegram expires typing actions after ~5s
        await ctx.replyWithChatAction("typing");

        await router.dispatch("telegram", {
            chatId: ctx.chat.id,
            userId: ctx.from.id,
            text,
        });
    } catch (err) {
        console.error("❌ Router dispatch error:", err);
        await ctx.reply("⚠️ Something went wrong processing your message. Check the logs.");
    } finally {
        if (typingInterval) clearInterval(typingInterval);
    }
});

// ── Photo message handler ──────────────────────────────────────────
bot.on("message:photo", async (ctx) => {
    await ctx.replyWithChatAction("typing");

    try {
        console.log(`🖼️ [${ctx.from.first_name}] sent a photo`);

        // Telegram arrays photos by sizes; grab the largest one
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const file = await ctx.getFile();
        if (!file.file_path) throw new Error("No file path found for photo");

        const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const arrayBuffer = await response.arrayBuffer();

        const tempFilePath = path.join(tmpDir, `${uuidv4()}.jpg`);
        fs.writeFileSync(tempFilePath, Buffer.from(arrayBuffer));

        const caption = ctx.message.caption || "";
        const intelligence = await extractAndStoreImageIntelligence(tempFilePath, caption);

        // Clean up
        fs.unlinkSync(tempFilePath);

        await ctx.reply("📸 Image processed and stored in long-term memory:\n" + intelligence);

    } catch (err) {
        console.error("❌ Photo processing error:", err);
        await ctx.reply("⚠️ Something went wrong trying to extract visual intel from that image.");
    }
});

// ── Voice message handler ──────────────────────────────────────────
bot.on("message:voice", async (ctx) => {
    let typingInterval: NodeJS.Timeout | null = null;

    try {
        console.log(`🎤 [${ctx.from.first_name}] sent a voice message`);

        typingInterval = setInterval(() => {
            ctx.replyWithChatAction("typing").catch(() => { });
        }, 4000);
        await ctx.replyWithChatAction("record_voice");

        // 1. Download voice file
        const file = await ctx.getFile();
        if (!file.file_path) {
            throw new Error("No file path found for voice message.");
        }

        const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const arrayBuffer = await response.arrayBuffer();

        const tempFilePath = path.join(tmpDir, `${uuidv4()}.oga`);
        fs.writeFileSync(tempFilePath, Buffer.from(arrayBuffer));

        // 2. Transcribe using Whisper (Assumes transcribeVoiceMessage from earlier if rewritten, but maintaining original file structure logic for now using existing transcribeAudio)
        const transcribedText = await transcribeAudio(tempFilePath);
        console.log(`📝 Transcribed: "${transcribedText}"`);

        // Cleanup temp file
        fs.unlinkSync(tempFilePath);

        // 3. Send to router
        await router.dispatch("telegram", {
            chatId: ctx.chat.id,
            userId: ctx.from.id,
            text: transcribedText,
            metadata: { voiceReply: true },
        });

    } catch (err) {
        console.error("❌ Voice processing error:", err);
        await ctx.reply("⚠️ Something went wrong processing your voice message. Please make sure OpenAI and ElevenLabs API keys are configured correctly.");
    } finally {
        if (typingInterval) clearInterval(typingInterval);
    }
});

/** Split a long message into chunks at line boundaries */
function splitMessage(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLen) {
        // Try to split at a newline
        let splitAt = remaining.lastIndexOf("\n", maxLen);
        if (splitAt === -1 || splitAt < maxLen / 2) {
            // No good newline — split at space
            splitAt = remaining.lastIndexOf(" ", maxLen);
        }
        if (splitAt === -1 || splitAt < maxLen / 2) {
            // No good split point — hard cut
            splitAt = maxLen;
        }

        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trimStart();
    }

    if (remaining) chunks.push(remaining);
    return chunks;
}

// ── Telegram Channel Export ─────────────────────────────────────────
export const telegramChannel: Channel = {
    id: "telegram",
    async send(message: RouterMessage) {
        try {
            if (message.metadata?.voiceReply) {
                // Synthesize voice using ElevenLabs
                await bot.api.sendChatAction(message.chatId, "record_voice");
                const audioBuffer = await generateSpeech(message.text);

                // Reply with text and voice
                await bot.api.sendMessage(message.chatId, message.text);
                await bot.api.sendVoice(message.chatId, new InputFile(audioBuffer, "reply.mp3"));
            } else {
                // Telegram has a 4096 char limit per message — split if needed
                if (message.text.length <= 4096) {
                    await bot.api.sendMessage(message.chatId, message.text);
                } else {
                    const chunks = splitMessage(message.text, 4096);
                    for (const chunk of chunks) {
                        await bot.api.sendMessage(message.chatId, chunk);
                    }
                }
            }
        } catch (err) {
            console.error("❌ Telegram channel delivery error:", err);
        }
    }
};
