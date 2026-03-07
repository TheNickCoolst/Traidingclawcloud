import fs from "fs";
import path from "path";
import { registerTool } from "../tools/index.js";

const skillsDir = path.join(process.cwd(), "data", "skills");

if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
}

export async function loadSkills() {
    console.log("🧩 [Skills] Scanning for dynamic skills...");

    try {
        const files = fs.readdirSync(skillsDir);
        for (const file of files) {
            if (file.endsWith(".js") || file.endsWith(".ts")) {
                const fullPath = path.join(skillsDir, file);

                try {
                    // Dynamically import the script file
                    // Note: If using pure TS without a runtime transpiler, only .js files will cleanly import here
                    const skillModule = await import(`file://${fullPath}`);

                    if (skillModule.definition && skillModule.handler) {
                        registerTool(
                            skillModule.definition.name,
                            skillModule.definition.description,
                            skillModule.definition.parameters,
                            skillModule.handler
                        );
                        console.log(`   ✅ Loaded dynamic skill: ${skillModule.definition.name}`);
                    } else {
                        console.warn(`   ⚠️ Skill file skipped (missing exported 'definition' or 'handler'): ${file}`);
                    }
                } catch (moduleErr: any) {
                    console.error(`   ❌ Failed to load skill ${file}:`, moduleErr.message);
                }
            }
        }
    } catch (err: any) {
        console.error("❌ [Skills] Manager encountered an error:", err.message);
    }
}
