import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function canOpenBetterSqlite3() {
    try {
        const BetterSqlite3 = require("better-sqlite3");
        const db = new BetterSqlite3(":memory:");
        db.prepare("SELECT 1").get();
        db.close();
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[native-check] better-sqlite3 failed to load: ${message}`);
        return false;
    }
}

if (!canOpenBetterSqlite3()) {
    console.log("[native-check] Rebuilding better-sqlite3 for the active Node.js runtime...");
    execSync("npm rebuild better-sqlite3", {
        stdio: "inherit"
    });

    if (!canOpenBetterSqlite3()) {
        throw new Error(
            "better-sqlite3 is still unusable after rebuild. Delete node_modules and run `npm install` again with the same Node.js architecture you use to start the app."
        );
    }

    console.log("[native-check] better-sqlite3 rebuilt successfully.");
}
