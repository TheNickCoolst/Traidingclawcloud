import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import path from "path";
import fs from "fs";
import { syncMemoryToMarkdown } from "./memory/markdown.js";
import { syncMemoryToSupabase } from "./memory/supabase.js";

// Create a data directory in the project root if it doesn't exist
const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize SQLite database
const dbPath = path.join(dataDir, "tradingclaw.db");
function openDatabase(): DatabaseType {
    try {
        return new Database(dbPath);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isNativeLoadFailure =
            message.includes("better_sqlite3.node") ||
            message.includes("Win32-Anwendung") ||
            message.includes("Win32 application") ||
            message.includes("ERR_DLOPEN_FAILED");

        if (isNativeLoadFailure) {
            throw new Error(
                [
                    `Failed to open SQLite database at ${dbPath}.`,
                    "The native better-sqlite3 module does not match the active Node.js runtime.",
                    "Run `npm rebuild better-sqlite3` and then start the app again.",
                    `Node: ${process.version} ${process.platform}/${process.arch}`,
                    `Original error: ${message}`
                ].join(" ")
            );
        }

        throw error;
    }
}

export const db: DatabaseType = openDatabase();

db.pragma("journal_mode = WAL"); // Better concurrency and performance

// ── Initialize Schema ────────────────────────────────────────────────────────

// 1. Create or upgrade the primary table for memories
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    tags TEXT,             -- JSON array of strings
    embedding BLOB,        -- Vector embeddings for similarity search
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    access_count INTEGER DEFAULT 0
  );
`);

// Try adding columns safely in case the table already existed in a previous version
try { db.exec("ALTER TABLE memories ADD COLUMN tags TEXT;"); } catch (e) { }
try { db.exec("ALTER TABLE memories ADD COLUMN embedding BLOB;"); } catch (e) { }
try { db.exec("ALTER TABLE memories ADD COLUMN accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP;"); } catch (e) { }
try { db.exec("ALTER TABLE memories ADD COLUMN access_count INTEGER DEFAULT 0;"); } catch (e) { }

// 2. Create the FTS5 virtual table for fast full-text search
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content='memories', -- use the standard table for storage
    content_rowid='id'
  );
`);

// 3. Create triggers to keep the FTS index synchronized automatically
db.exec(`
  DROP TRIGGER IF EXISTS t_memories_ai;
  DROP TRIGGER IF EXISTS t_memories_ad;
  DROP TRIGGER IF EXISTS t_memories_au;

  -- Trigger for INSERT
  CREATE TRIGGER t_memories_ai AFTER INSERT ON memories
  BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
  END;

  -- Trigger for DELETE
  CREATE TRIGGER t_memories_ad AFTER DELETE ON memories
  BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;

  -- Trigger for UPDATE
  CREATE TRIGGER t_memories_au AFTER UPDATE ON memories
  BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
  END;
`);

// 4. Create constraints for agent sessions
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    messages_json TEXT NOT NULL,
    summary TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 5. Create Knowledge Graph schema
db.exec(`
  CREATE TABLE IF NOT EXISTS kg_nodes (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    type TEXT NOT NULL,
    attributes TEXT, -- JSON string
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS kg_edges (
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    label TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source, target, label),
    FOREIGN KEY (source) REFERENCES kg_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target) REFERENCES kg_nodes(id) ON DELETE CASCADE
  );
`);

// 6. Create token usage tracking
db.exec(`
  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    api_key_slot INTEGER,
    runtime_role TEXT,
    cycle_mode TEXT,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
try { db.exec("ALTER TABLE token_usage ADD COLUMN api_key_slot INTEGER;"); } catch (e) { }
try { db.exec("ALTER TABLE token_usage ADD COLUMN runtime_role TEXT;"); } catch (e) { }
try { db.exec("ALTER TABLE token_usage ADD COLUMN cycle_mode TEXT;"); } catch (e) { }

// ── Database Operations ──────────────────────────────────────────────────────

export interface Memory {
  id: number;
  content: string;
  tags?: string;
  embedding?: Buffer | null;
  created_at: string;
  accessed_at: string;
  access_count: number;
}

export interface Session {
  id: string;
  channel: string;
  messages_json: string;
  summary?: string;
  created_at: string;
}

const stmts = {
  add: db.prepare("INSERT INTO memories (content, tags, embedding) VALUES (?, ?, ?)"),
  delete: db.prepare("DELETE FROM memories WHERE id = ?"),
  search: db.prepare(`
    SELECT m.id, m.content, m.tags, m.embedding, m.created_at, m.accessed_at, m.access_count
    FROM memories_fts f
    JOIN memories m ON f.rowid = m.id
    WHERE memories_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `),
  markAccessed: db.prepare(`
    UPDATE memories 
    SET accessed_at = CURRENT_TIMESTAMP, access_count = access_count + 1 
    WHERE id = ?
  `),
  getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
  saveSession: db.prepare(`
    INSERT INTO sessions (id, channel, messages_json, summary) 
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET 
      messages_json = excluded.messages_json,
      summary = excluded.summary
  `),
  deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
  logTokenUsage: db.prepare(`
    INSERT INTO token_usage (provider, model, api_key_slot, runtime_role, cycle_mode, prompt_tokens, completion_tokens, total_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getUsageStats: db.prepare(`
    SELECT 
      SUM(CASE WHEN created_at >= DATETIME('now', '-1 hour') THEN prompt_tokens ELSE 0 END) as '1h_prompt',
      SUM(CASE WHEN created_at >= DATETIME('now', '-1 hour') THEN completion_tokens ELSE 0 END) as '1h_comp',
      SUM(CASE WHEN created_at >= DATETIME('now', '-1 hour') THEN 1 ELSE 0 END) as '1h_req',
      SUM(CASE WHEN created_at >= DATETIME('now', '-3 hours') THEN prompt_tokens ELSE 0 END) as '3h_prompt',
      SUM(CASE WHEN created_at >= DATETIME('now', '-3 hours') THEN completion_tokens ELSE 0 END) as '3h_comp',
      SUM(CASE WHEN created_at >= DATETIME('now', '-3 hours') THEN 1 ELSE 0 END) as '3h_req',
      SUM(CASE WHEN created_at >= DATETIME('now', '-1 day') THEN prompt_tokens ELSE 0 END) as '24h_prompt',
      SUM(CASE WHEN created_at >= DATETIME('now', '-1 day') THEN completion_tokens ELSE 0 END) as '24h_comp',
      SUM(CASE WHEN created_at >= DATETIME('now', '-1 day') THEN 1 ELSE 0 END) as '24h_req',
      SUM(CASE WHEN created_at >= DATETIME('now', '-7 days') THEN prompt_tokens ELSE 0 END) as '7d_prompt',
      SUM(CASE WHEN created_at >= DATETIME('now', '-7 days') THEN completion_tokens ELSE 0 END) as '7d_comp',
      SUM(CASE WHEN created_at >= DATETIME('now', '-7 days') THEN 1 ELSE 0 END) as '7d_req',
      SUM(CASE WHEN created_at >= DATETIME('now', '-30 days') THEN prompt_tokens ELSE 0 END) as '30d_prompt',
      SUM(CASE WHEN created_at >= DATETIME('now', '-30 days') THEN completion_tokens ELSE 0 END) as '30d_comp',
      SUM(CASE WHEN created_at >= DATETIME('now', '-30 days') THEN 1 ELSE 0 END) as '30d_req',
      SUM(prompt_tokens) as 'all_prompt',
      SUM(completion_tokens) as 'all_comp',
      COUNT(*) as 'all_req'
    FROM token_usage
  `)
};

/** Add a new memory to the database */
export function addMemory(content: string, tags?: string[], embedding?: Buffer): number {
  const tagsJson = tags ? JSON.stringify(tags) : null;
  const result = stmts.add.run(content, tagsJson, embedding || null);
  const id = result.lastInsertRowid as number;

  // Reconstruct memory object to dispatch to sync hooks
  const memoryObj: Memory = {
    id,
    content,
    tags: tagsJson || undefined,
    embedding: embedding || null,
    created_at: new Date().toISOString(),
    accessed_at: new Date().toISOString(),
    access_count: 0
  };

  syncMemoryToMarkdown(memoryObj);
  syncMemoryToSupabase(memoryObj).catch(err => console.error("Supabase Sync Err:", err));

  return id;
}

/** Delete a memory by its ID */
export function deleteMemory(id: number): boolean {
  const result = stmts.delete.run(id);
  return result.changes > 0;
}

/** Search memories using FTS5 match ranking */
export function searchMemories(query: string, limit: number = 5): Memory[] {
  // SQLite FTS requires queries to be formatted carefully.
  // We wrap terms in quotes to handle special characters gracefully.
  // A simple strategy is to escape double quotes and wrap the whole query.
  const escapedQuery = query.replace(/"/g, '""');
  const matchQuery = `"${escapedQuery}"`;

  try {
    const results = stmts.search.all(matchQuery, limit) as Memory[];
    // Mark as accessed
    for (const memory of results) {
      stmts.markAccessed.run(memory.id);
    }
    return results;
  } catch (err) {
    console.warn(`[DB] FTS Search error for query "${query}":`, err);
    return [];
  }
}

// ── Session Operations ───────────────────────────────────────────────────────

/** Get a session by ID */
export function getSession(id: string): Session | undefined {
  return stmts.getSession.get(id) as Session | undefined;
}

/** Save or update a session */
export function saveSession(id: string, channel: string, messagesJson: string, summary?: string): void {
  stmts.saveSession.run(id, channel, messagesJson, summary || null);
}

/** Delete a session */
export function deleteSession(id: string): boolean {
  const result = stmts.deleteSession.run(id);
  return result.changes > 0;
}

// ── Token Usage Operations ───────────────────────────────────────────────────

export function logTokenUsage(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  meta?: { apiKeySlot?: number; runtimeRole?: string; cycleMode?: string }
) {
  try {
    const keySlot = Number.isFinite(meta?.apiKeySlot) ? Number(meta?.apiKeySlot) : null;
    const runtimeRole = meta?.runtimeRole ? String(meta.runtimeRole) : null;
    const cycleMode = meta?.cycleMode ? String(meta.cycleMode) : null;
    stmts.logTokenUsage.run(provider, model, keySlot, runtimeRole, cycleMode, promptTokens, completionTokens, totalTokens);
  } catch (err) {
    console.error("⚠️ Failed to log token usage:", err);
  }
}

export interface TokenUsageStats {
  '1h_prompt': number; '1h_comp': number; '1h_req': number;
  '3h_prompt': number; '3h_comp': number; '3h_req': number;
  '24h_prompt': number; '24h_comp': number; '24h_req': number;
  '7d_prompt': number; '7d_comp': number; '7d_req': number;
  '30d_prompt': number; '30d_comp': number; '30d_req': number;
  'all_prompt': number; 'all_comp': number; 'all_req': number;
}

export function getTokenUsageStats(): TokenUsageStats {
  try {
    const stats = stmts.getUsageStats.get() as any;
    return {
      '1h_prompt': stats['1h_prompt'] || 0, '1h_comp': stats['1h_comp'] || 0, '1h_req': stats['1h_req'] || 0,
      '3h_prompt': stats['3h_prompt'] || 0, '3h_comp': stats['3h_comp'] || 0, '3h_req': stats['3h_req'] || 0,
      '24h_prompt': stats['24h_prompt'] || 0, '24h_comp': stats['24h_comp'] || 0, '24h_req': stats['24h_req'] || 0,
      '7d_prompt': stats['7d_prompt'] || 0, '7d_comp': stats['7d_comp'] || 0, '7d_req': stats['7d_req'] || 0,
      '30d_prompt': stats['30d_prompt'] || 0, '30d_comp': stats['30d_comp'] || 0, '30d_req': stats['30d_req'] || 0,
      'all_prompt': stats['all_prompt'] || 0, 'all_comp': stats['all_comp'] || 0, 'all_req': stats['all_req'] || 0,
    };
  } catch (err) {
    console.error("⚠️ Failed to get token usage stats:", err);
    return {
      '1h_prompt': 0, '1h_comp': 0, '1h_req': 0,
      '3h_prompt': 0, '3h_comp': 0, '3h_req': 0,
      '24h_prompt': 0, '24h_comp': 0, '24h_req': 0,
      '7d_prompt': 0, '7d_comp': 0, '7d_req': 0,
      '30d_prompt': 0, '30d_comp': 0, '30d_req': 0,
      'all_prompt': 0, 'all_comp': 0, 'all_req': 0
    };
  }
}
