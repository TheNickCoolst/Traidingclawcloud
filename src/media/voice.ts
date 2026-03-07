import fs from "fs";
import { bot } from "../bot.js";
import { config } from "../config.js";

/**
 * Downloads a voice message from Telegram, transcribes it using OpenAI Whisper,
 * and returns the transcribed text.
 */
export async function transcribeVoiceMessage(fileId: string): Promise<string> {
    console.log(`🎤 [Voice] Transcribing audio file: ${fileId}...`);

    try {
        // 1. Get the Telegram download link
        const file = await bot.api.getFile(fileId);
        if (!file.file_path) {
            throw new Error("Telegram did not return a valid file path.");
        }

        const telegramUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;

        // 2. Download the actual audio buffer
        const audioResponse = await fetch(telegramUrl);
        if (!audioResponse.ok) {
            throw new Error(`Failed to download audio: ${audioResponse.statusText}`);
        }

        const arrayBuffer = await audioResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // 3. Form-encode it for OpenAI Whisper
        const formData = new FormData();
        const blob = new Blob([buffer], { type: 'audio/ogg' });
        formData.append("file", blob, "voice.ogg");
        formData.append("model", "whisper-1");

        // 4. Send to Whisper API
        const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${config.openaiApiKey}`,
            },
            body: formData,
        });

        if (!whisperRes.ok) {
            const errBody = await whisperRes.text();
            throw new Error(`OpenAI Whisper error: ${whisperRes.status} - ${errBody}`);
        }

        const data = await whisperRes.json() as { text: string };
        console.log(`✅ [Voice] Transcription complete: "${data.text}"`);
        return data.text;

    } catch (err: any) {
        console.error("❌ Transcription error:", err.message);
        throw err;
    }
}
