import Database from 'better-sqlite3';
import fs from 'fs';
const db = new Database('./data/tradingclaw.db');
const rows = db.prepare('SELECT id, created_at, cycle_type, summary FROM cycle_log ORDER BY id DESC LIMIT 5').all();
fs.writeFileSync('test_dump.json', JSON.stringify(rows, null, 2));
