import "dotenv/config";
import { runWatchlistScreen, formatScreenResult } from "./src/trading/screener.js";
import fs from "fs";

async function main() {
    console.log("Running Watchlist Screener...\n");
    try {
        const result = await runWatchlistScreen();
        fs.writeFileSync("screener_out.txt", formatScreenResult(result), "utf-8");
        console.log("Done. Wrote to screener_out.txt");
    } catch (e) {
        console.error("Error:", e);
    }
}

main();
