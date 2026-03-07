import { chat } from "../llm.js";
import { addMemory } from "../db.js";
import * as fs from "fs";

/**
 * Extracts intelligence from an image using the LLM and stores it persistently.
 */
export async function extractAndStoreImageIntelligence(imagePath: string, caption?: string): Promise<string> {
    try {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString("base64");
        // We assume JPEG for simplicity in Telegram's compressed photos, 
        // a more robust approach checks magic bytes.
        const mimeType = "image/jpeg";

        const contentPayload: any[] = [
            {
                type: "text",
                text: `Please analyze this image. ${caption ? `The user provided this caption: "${caption}". ` : ""}Describe the core contents, entities, and any text visible in the image. Be specific, as this will trigger a long-term memory save.`
            },
            {
                type: "image_url",
                image_url: {
                    url: `data:${mimeType};base64,${base64Image}`
                }
            }
        ];

        const response = await chat({
            // Force OpenRouter fallback to ensure we hit a vision-capable model
            modelOverride: "google/gemini-2.5-flash",
            messages: [{
                role: "user",
                content: contentPayload as any
            }]
        });

        const description = response.content || "No description extracted.";

        // Save the extraction
        const memoryText = `[User sent an image] ${caption ? `Caption: ${caption}. ` : ""}Intelligence extracted: ${description}`;
        const id = addMemory(memoryText, ["media", "image"]);

        return memoryText;
    } catch (err) {
        console.error("🖼️ Multimodal extraction failed:", err);
        return "Failed to extract intelligence from the image.";
    }
}
