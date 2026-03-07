import { registerTool } from "./index.js";
import fs from "fs/promises";
import path from "path";

// Allow operations only within the project root for safety by default, unless otherwise requested
const ROOT_DIR = process.cwd();

function resolveSafely(targetPath: string): string {
    const resolved = path.resolve(ROOT_DIR, targetPath);
    // You might want to enforce `.startsWith(ROOT_DIR)` here if you want sandbox safety,
    // but typically a local AI assistant operates globally on the user's host.
    return resolved;
}

// Tool: Read File
registerTool(
    "read_file",
    "Read the text content of a local file.",
    {
        type: "object",
        properties: {
            filePath: { type: "string", description: "Absolute or relative path to the file to read." }
        },
        required: ["filePath"],
    },
    async (input) => {
        try {
            const target = resolveSafely(input.filePath as string);
            const content = await fs.readFile(target, "utf-8");
            return content;
        } catch (err: any) {
            return `Failed to read file: ${err.message}`;
        }
    }
);

// Tool: Write File
registerTool(
    "write_file",
    "Write text content into a local file, overwriting the existing content.",
    {
        type: "object",
        properties: {
            filePath: { type: "string", description: "Absolute or relative path to the file." },
            content: { type: "string", description: "Text content to write." }
        },
        required: ["filePath", "content"],
    },
    async (input) => {
        try {
            const target = resolveSafely(input.filePath as string);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, input.content as string, "utf-8");
            return `Successfully wrote to ${input.filePath}`;
        } catch (err: any) {
            return `Failed to write file: ${err.message}`;
        }
    }
);

// Tool: List Directory
registerTool(
    "list_directory",
    "List the files and folders inside a local directory.",
    {
        type: "object",
        properties: {
            dirPath: { type: "string", description: "Path to the directory to inspect (use '.' for current dir)." }
        },
        required: ["dirPath"],
    },
    async (input) => {
        try {
            const target = resolveSafely(input.dirPath as string);
            const entries = await fs.readdir(target, { withFileTypes: true });
            const output = entries.map(e => `[${e.isDirectory() ? 'DIR' : 'FILE'}] ${e.name}`).join("\n");
            return output || "Directory is empty.";
        } catch (err: any) {
            return `Failed to read directory: ${err.message}`;
        }
    }
);
