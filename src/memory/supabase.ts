import { createClient } from "@supabase/supabase-js";
import type { Memory } from "../db.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

const enabled = !!(SUPABASE_URL && SUPABASE_KEY);
const supabase = enabled ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

/**
 * Sync memory to Supabase. Gracefully returns early if not configured.
 */
export async function syncMemoryToSupabase(memory: Memory): Promise<void> {
    if (!enabled || !supabase) return;

    try {
        // Assuming a table structure `memories(id, content, tags_json, created_at, access_count)`
        const tagsArr = memory.tags ? JSON.parse(memory.tags) : [];

        const { error } = await supabase.from('memories').upsert({
            id: memory.id, // Keeping ID synced with SQLite
            content: memory.content,
            tags_json: JSON.stringify(tagsArr),
            created_at: memory.created_at,
            access_count: memory.access_count,
            // (Optionally could sync embedding vectors here if pgvector is setup)
        });

        if (error) {
            console.error("Supabase sync warning:", error.message);
        }
    } catch (err: any) {
        console.error("Supabase error:", err.message);
    }
}
