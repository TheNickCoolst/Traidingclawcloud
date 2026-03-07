import './src/trading/tools.js';
import './src/tools/search.js';
import { manualTradingCycle } from './src/trading/engine.js';
import { getTradingStatus } from './src/trading/engine.js';

async function test() {
    console.log('--- Trading Status ---');
    console.log(await getTradingStatus());
    console.log('--- Running Cycle ---');
    const res = await manualTradingCycle();
    console.log('--- Final Result ---');
    console.log(res);
}

test().catch(console.error);
