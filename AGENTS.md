# Repository Guidelines

## Project Structure & Module Organization
Core application code lives in `src/` and is organized by domain: `trading/` (strategy + execution), `tools/` (tool registry and integrations), `llm/`, `automation/`, `memory/`, and `channels/`. Entry point is `src/index.ts`.

Runtime and deployment folders:
- `data/`: local SQLite data (for example `data/tradingclaw.db`).
- `dist/`: compiled JavaScript output from TypeScript build.
- `hardware/esp32_bridge/`: ESP32/webhook bridge code.
- `workers/proxy/`: Cloudflare Worker proxy.
- Root `test_*.ts` files: script-based integration/smoke checks.

## Trading Engine & Strategy Context (v3.0)
TradingClaw v3.0 is an autonomous AI trading system that operates in a multi-cycle format. If you modify `src/trading/engine.ts` or related trading logic, you must adhere to these guardrails:

**Engine Architecture**
- **Trading Cycle (Configurable, default 3h):** Evaluates overall account status, screens the watchlist using multi-factor scoring (RSI, EMA, Volume, MACD), searches the web for news (avoiding bad news), calculates ATR-based risk/sizes, places limit BUY orders, and applies mandatory stop-losses.
- **Light Cycle (Every 1 min):** Fast evaluation loop for open positions strictly to manage exits (trailing stops, take-profit limits, stop-losses). It must NEVER screen for new buys or buy stock (designed to save context window and API costs).
- **Reflection Cycle (Every 24h):** Self-reflection summarizing the last 24h of trades. Extracts "LESSONS LEARNED" which feed continuously into the subsequent Trading Cycles.

**Strategy & Risk Management**
- **Position Sizing:** 2% risk per trade (ATR-based), capped at maximum 10% of total equity per single position.
- **Limits:** Maximum 7 open positions. Maximum 2 positions per sector (e.g., Technology, Healthcare).
- **Cash Rules:** Must maintain â‰¥60% of equity invested. If cash exceeds 40%, the agent must actively look for buys.
- **Entry Criteria:** Score â‰¥ 3/6. Buy orders use LIMIT prices (0.2% above current price). Every buy must immediately set a trailing stop (2x ATR) and a take-profit order (+10%).
- **Automated Exits:** 
  1. Break-even stop logic activates at +3% profit.
  2. Tightened stop (1.5x ATR) activates at +5% profit.
  3. Hard floor stop-loss at -7% as a safety net.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: run the bot in watch mode with `tsx` (`src/index.ts`).
- `npm run build`: compile TypeScript to `dist/`.
- `npm start`: run the compiled build (`dist/index.js`).
- `docker-compose up -d`: start containerized services for local deployment.
- `npx tsx test_cycle.ts`: run a manual trading cycle smoke test.
- `npx tsx test_screener.ts`: run watchlist screener and write `screener_out.txt`.

## Coding Style & Naming Conventions
Use strict TypeScript (`tsconfig.json` has `"strict": true`) with NodeNext ESM imports. Keep import specifiers ending in `.js` inside `.ts` files (project convention).

Style conventions in this repo:
- 4-space indentation, semicolons, and concise module-level comments.
- File names are lowercase with hyphen/word separators (examples: `self-evolving.ts`, `get-current-time.ts`).
- `camelCase` for functions/variables, `PascalCase` for types/classes, `UPPER_SNAKE_CASE` for constants.

No dedicated lint/format tool is configured; use `npm run build` as the minimum quality gate.

## Testing Guidelines
This project currently uses script-driven integration tests rather than Jest/Vitest. Follow existing naming: `test_*.ts` (root) and `src/test_*.ts`.

Before opening a PR, run:
1. `npm run build`
2. Relevant `npx tsx test_*.ts` scripts for changed areas

Prefer paper-trading/sandbox credentials in `.env` when running trading tests.

## Commit & Pull Request Guidelines
Recent history mixes imperative summaries and Conventional Commit style (`feat:`), plus release tags (for example `v3 release`). Prefer: `<type>: <short imperative summary>` (example: `fix: handle empty screener response`).

PRs should include:
1. What changed and why
2. Any `.env`/schema/runtime impact
3. Commands run and outcomes
4. Linked issue/task
5. Logs or screenshots for user-facing Telegram/trading behavior changes

## Security & Configuration Tips
Copy `.env.example` to `.env`; never commit secrets or tokens. Keep local DB artifacts and generated dumps out of commits unless explicitly required.
