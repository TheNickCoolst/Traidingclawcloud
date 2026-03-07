import { chat } from "../llm.js";
import { db, searchMemories, deleteMemory } from "../db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function evolveMemoryDatabase(): Promise<string> {
    console.log("🧹 [Self-Evolving Memory] Background evolution started...");
    let logs: string[] = [];

    // 1. Tag unlabeled memories
    const untaggedSearch = db.prepare(`SELECT id, content FROM memories WHERE tags IS NULL OR tags = 'null' LIMIT 10`);
    const untaggedResults = untaggedSearch.all() as any[];

    if (untaggedResults.length > 0) {
        for (const memory of untaggedResults) {
            try {
                const response = await chat({
                    systemPrompt: "You are a specialized tagging system. Output ONLY a valid JSON array of 3 exact keyword strings summarizing the user's content. E.g. [\"crypto\", \"ethereum\", \"price\"]. No other text.",
                    messages: [{ role: "user", content: memory.content }]
                });

                const tags = JSON.parse(response.content || "[]");
                if (Array.isArray(tags) && tags.length > 0) {
                    db.prepare(`UPDATE memories SET tags = ? WHERE id = ?`).run(JSON.stringify(tags), memory.id);
                    logs.push(`- Tagged memory #${memory.id} with ${JSON.stringify(tags)}`);
                }
            } catch (err) {
                console.warn(`[Evolution] Failed to autotag ${memory.id}`, err);
            }
        }
    }

    // 2. Forget heavily decayed memories (older than 30 days w/ low access rate)
    // Decrement the access_counter on memories haven't been touched in over 30 days
    db.prepare(`
        UPDATE memories 
        SET access_count = MAX(0, access_count - 1)
        WHERE accessed_at < datetime('now', '-30 days')
    `).run();

    const forgetResult = db.prepare(`
        DELETE FROM memories 
        WHERE access_count = 0 AND accessed_at < datetime('now', '-90 days')
    `).run();

    if (forgetResult.changes > 0) {
        logs.push(`- Permanently forgot ${forgetResult.changes} severely decayed memories.`);
    }

    const finalSummary = logs.length > 0 ? logs.join("\n") : "Evolution complete. No significant changes required.";
    console.log("✅ [Self-Evolving Memory] Finished\n" + finalSummary);
    return finalSummary;
}
