import fs from "fs";
import path from "path";
import type { Memory } from "../db.js";

const memoryDir = path.join(process.cwd(), "data", "memory");
if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
}

/**
 * Synchronize a single memory object to a local markdown file.
 */
export function syncMemoryToMarkdown(memory: Memory): void {
    const filename = `mem_${memory.id}.md`;
    const filePath = path.join(memoryDir, filename);

    const tagsArr = memory.tags ? JSON.parse(memory.tags) : [];

    // Construct frontmatter YAML
    const frontmatter = `---
id: ${memory.id}
created_at: "${memory.created_at}"
accessed_at: "${memory.accessed_at}"
access_count: ${memory.access_count}
tags: [${tagsArr.map((t: string) => `"${t}"`).join(", ")}]
---

`;

    const markdownContent = frontmatter + memory.content + "\n";

    fs.writeFileSync(filePath, markdownContent, "utf8");
}
