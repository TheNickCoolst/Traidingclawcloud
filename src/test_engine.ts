import { manualTradingCycle } from "./trading/engine.js";

async function main() {
    console.log("Starting manual trading cycle test...");
    try {
        const res = await manualTradingCycle();
        console.log("Cycle Result:", res);
    } catch (e) {
        console.error("Error:", e);
    }
    process.exit(0);
}

main();
