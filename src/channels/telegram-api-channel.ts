import { config } from "../config.js";
import type { Channel, RouterMessage } from "./router.js";

const TELEGRAM_SEND_MESSAGE_URL = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
const TELEGRAM_TEXT_LIMIT = 4096;

function splitMessage(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLen) {
        let splitAt = remaining.lastIndexOf("\n", maxLen);
        if (splitAt === -1 || splitAt < maxLen / 2) {
            splitAt = remaining.lastIndexOf(" ", maxLen);
        }
        if (splitAt === -1 || splitAt < maxLen / 2) {
            splitAt = maxLen;
        }

        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trimStart();
    }

    if (remaining) chunks.push(remaining);
    return chunks;
}

async function sendChunk(chatId: number, text: string): Promise<void> {
    const response = await fetch(TELEGRAM_SEND_MESSAGE_URL, {
        method: "POST",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
        }),
    });

    if (!response.ok) {
        const details = await response.text().catch(() => "");
        throw new Error(`Telegram API send failed (${response.status}): ${details.slice(0, 200)}`);
    }
}

export const telegramApiChannel: Channel = {
    id: "telegram",
    async send(message: RouterMessage) {
        const chunks = message.text.length <= TELEGRAM_TEXT_LIMIT
            ? [message.text]
            : splitMessage(message.text, TELEGRAM_TEXT_LIMIT);

        for (const chunk of chunks) {
            await sendChunk(message.chatId, chunk);
        }
    },
};
