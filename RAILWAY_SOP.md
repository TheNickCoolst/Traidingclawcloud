# Railway SOP - TradingClaw (2 Trading Services + Railway Scheduler)

Produktiv laeuft TradingClaw aktuell mit:

- `tradingclawpaper100kusd`
- `tradingclaw-mini`
- `market-scheduler` als Railway-Cron/Funktion

Alle Schedules verwenden US-Regular-Market-Hours (`America/New_York`, Mon-Fri, 09:30-16:00).

## 1) One-time CLI setup

```bash
npm install -g @railway/cli
railway login
railway link
```

## 2) Create services

```bash
railway add --service tradingclawpaper100kusd
railway add --service tradingclaw-mini
railway functions new --name market-scheduler --path railway/market-scheduler.mjs --cron "*/10 * * * *" --http false --serverless true
```

## 3) Push shared `.env` values

Fast path fuer die aktuellen Produktiv-Defaults:

```powershell
npm run railway:apply-prod-vars
```

Damit werden:

- `tradingclawpaper100kusd`
- `tradingclaw-mini`
- optional `market-scheduler`

auf die aktuellen Repo-Defaults gesetzt.

## 4) Role-specific variables

`tradingclawpaper100kusd`

```bash
railway variables set TRADING_RUNTIME_ROLE="all" --service tradingclawpaper100kusd --skip-deploys
railway variables set TELEGRAM_ENABLED="true" --service tradingclawpaper100kusd --skip-deploys
railway variables set MCP_ENABLED="true" --service tradingclawpaper100kusd --skip-deploys
railway variables set RAILWAY_BUDGET_MODE="true" --service tradingclawpaper100kusd --skip-deploys
railway variables set LIGHT_CYCLE_ENABLED="true" --service tradingclawpaper100kusd --skip-deploys
railway variables set LIGHT_CYCLE_INTERVAL_MINUTES="5" --service tradingclawpaper100kusd --skip-deploys
railway variables set ULTRA_LIGHT_CYCLE_ENABLED="true" --service tradingclawpaper100kusd --skip-deploys
railway variables set ULTRA_LIGHT_CYCLE_INTERVAL_MINUTES="1" --service tradingclawpaper100kusd --skip-deploys
railway variables set MARKET_CLOSED_EXIT_ENABLED="true" --service tradingclawpaper100kusd --skip-deploys
```

`tradingclaw-mini`

```bash
railway variables set TRADING_RUNTIME_ROLE="main" --service tradingclaw-mini --skip-deploys
railway variables set TELEGRAM_ENABLED="true" --service tradingclaw-mini --skip-deploys
railway variables set MCP_ENABLED="false" --service tradingclaw-mini --skip-deploys
railway variables set RAILWAY_BUDGET_MODE="true" --service tradingclaw-mini --skip-deploys
railway variables set LIGHT_CYCLE_ENABLED="false" --service tradingclaw-mini --skip-deploys
railway variables set ULTRA_LIGHT_CYCLE_ENABLED="false" --service tradingclaw-mini --skip-deploys
railway variables set ALPACA_ALLOW_FRACTIONAL_SHARES="true" --service tradingclaw-mini --skip-deploys
railway variables set DAILY_LOSS_LIMIT_AMOUNT="0.5" --service tradingclaw-mini --skip-deploys
railway variables set DAILY_LOSS_LIMIT_MIN_PERCENT="0.05" --service tradingclaw-mini --skip-deploys
railway variables set MARKET_CLOSED_EXIT_ENABLED="true" --service tradingclaw-mini --skip-deploys
```

`market-scheduler`

```bash
railway variables set RAILWAY_TOKEN="<railway-token>" --service market-scheduler --skip-deploys
railway variables set RAILWAY_PROJECT_ID="32cbb877-ae1b-4bbc-a7e5-8ecdc9ed8533" --service market-scheduler --skip-deploys
railway variables set RAILWAY_ENVIRONMENT_ID="6308f432-7178-4dad-b06d-0ed610a2d4e0" --service market-scheduler --skip-deploys
railway variables set MARKET_SCHEDULER_TARGET_SERVICES="tradingclawpaper100kusd,tradingclaw-mini" --service market-scheduler --skip-deploys
railway variables set ALPACA_API_KEY="<alpaca-key>" --service market-scheduler --skip-deploys
railway variables set ALPACA_API_SECRET="<alpaca-secret>" --service market-scheduler --skip-deploys
```

## 5) Deploy

Trading services:

```bash
railway up --service tradingclawpaper100kusd --detach
railway up --service tradingclaw-mini --detach
```

Scheduler function:

```bash
railway functions new --name market-scheduler --path railway/market-scheduler.mjs --cron "*/10 * * * *" --http false --serverless true
```

Wenn die Funktion schon existiert, die Datei erneut deployen oder ueber die Railway UI aktualisieren.

## 6) Verify

```bash
railway logs --service tradingclawpaper100kusd --lines 80
railway logs --service tradingclaw-mini --lines 80
railway service status --service tradingclawpaper100kusd --environment production
railway service status --service tradingclaw-mini --environment production
```

Scheduler-Lauf lokal pruefen:

```bash
npm run market-scheduler
```

Erwartung:

- bei Markt offen: Scheduler fordert `deploymentRestart` fuer gestoppte/fehlerhafte Services an
- bei Markt geschlossen: Scheduler fordert `deploymentStop` an
- Trading-Services loggen ausserhalb der Marktzeit einen sauberen Shutdown

## 7) Cost note

Kostenkontrolle kommt jetzt aus:

- 2 statt 4 produktiven Services
- `RAILWAY_BUDGET_MODE=true`
- direkter Railway-Cron statt GitHub-Scheduler
- ausserhalb Marktzeit konsequentes Stoppen der Trading-Services
- `mini` ohne MCP und ohne Fast-Cycles

## 8) GitHub fallback

Die Dateien

- `.github/workflows/railway-market-hours.yml`
- `.github/workflows/railway-teststart-now.yml`

bleiben als manueller Fallback erhalten, sind aber nicht mehr der primaere automatische Marktstart.
