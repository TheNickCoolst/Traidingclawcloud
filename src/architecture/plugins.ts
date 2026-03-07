import fs from "fs";
import path from "path";
import { EventEmitter } from "events";

export interface PluginContext {
    chatId: number;
    userId: number;
    text: string;
    metadata?: Record<string, any>;
}

// Global emitter serving as the nervous system for plugins
export const pluginHooks = new EventEmitter();

const pluginsDir = path.join(process.cwd(), "data", "plugins");
if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
}

/**
 * Dynamically loads plugins dropping lifecycle overrides into the emitter.
 */
export async function loadPlugins() {
    console.log("🔌 [Plugins] Scanning system hooks...");
    try {
        const files = fs.readdirSync(pluginsDir);
        for (const file of files) {
            if (file.endsWith(".js") || file.endsWith(".ts")) {
                const fullPath = path.join(pluginsDir, file);

                try {
                    const pluginModule = await import(`file://${fullPath}`);

                    // Expected Plugin Interface: { name: string, hooks: Record<string, Function> }
                    if (pluginModule.name && pluginModule.hooks) {
                        for (const [hookEvent, handler] of Object.entries(pluginModule.hooks)) {
                            pluginHooks.on(hookEvent, handler as any);
                        }
                        console.log(`   ✅ Loaded plugin: ${pluginModule.name} [Hooks: ${Object.keys(pluginModule.hooks).join(", ")}]`);
                    }
                } catch (moduleErr: any) {
                    console.error(`   ❌ Failed to load plugin ${file}:`, moduleErr.message);
                }
            }
        }
    } catch (err: any) {
        console.error("❌ [Plugins] Manager encountered an error:", err.message);
    }
}
