import OpenAI from "openai";
import fs from "fs";
import { config } from "./config.js";

// Initialize OpenAI client for Whisper
const openaiClient = new OpenAI({
    apiKey: config.openaiApiKey,
});

/**
 * Transcribe an audio file using OpenAI Whisper API.
 * @param filePath The path to the local audio file to transcribe.
 * @returns The transcribed text.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
    if (!config.openaiApiKey) {
        throw new Error("OPENAI_API_KEY is not set.");
    }

    const response = await openaiClient.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
    });

    return response.text;
}

/**
 * Synthesize speech from text using ElevenLabs API.
 * @param text The text to synthesize.
 * @returns A Buffer containing the MPEG audio.
 */
export async function generateSpeech(text: string): Promise<Buffer> {
    if (!config.elevenlabsApiKey) {
        throw new Error("ELEVENLABS_API_KEY is not set.");
    }

    const voiceId = config.elevenlabsVoiceId;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Accept": "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": config.elevenlabsApiKey,
        },
        body: JSON.stringify({
            text,
            model_id: "eleven_monolingual_v1",
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
            },
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}
