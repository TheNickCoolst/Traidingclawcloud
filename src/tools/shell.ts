import { registerTool } from "./index.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

registerTool(
    "execute_shell",
    "Execute a command in the local shell/terminal. ALWAYS use this to run scripts, system commands, or retrieve system information. IMPORTANT: Do not use this for destructive actions without double-checking.",
    {
        type: "object",
        properties: {
            command: {
                type: "string",
                description: "The full shell command to execute (e.g., 'ls -la', 'uname -a')",
            },
        },
        required: ["command"],
    },
    async (input) => {
        const command = input.command as string;
        console.log(`\n⚠️  [execute_shell] Running: ${command}\n`);

        try {
            // Limit to 30 second timeout, return stderr and stdout
            const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
            let result = stdout;
            if (stderr) {
                result += `\n[STDERR]:\n${stderr}`;
            }
            return result || "Command executed successfully (no output).";
        } catch (err: any) {
            return `Command failed: ${err.message}\n${err.stdout ? `[STDOUT]\n${err.stdout}` : ""}${err.stderr ? `[STDERR]\n${err.stderr}` : ""}`;
        }
    }
);
