# Railway SOP - TradingClaw (3-Service Budget Setup)

This setup runs three small services:
- `tradingclaw-main` -> main cycle + reflection + Telegram
- `tradingclaw-light` -> light cycle only
- `tradingclaw-ultra` -> ultra-light cycle only

All schedules use US regular market hours (`America/New_York`, Mon-Fri, 09:30-16:00).

## 1) One-time CLI setup

```bash
npm install -g @railway/cli
railway login
railway link
```

## 2) Create services

```bash
railway add --service tradingclaw-main
railway add --service tradingclaw-light
railway add --service tradingclaw-ultra
```

## 3) Push shared `.env` values to each service

Run this from project root (PowerShell):

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
  $pair = $_ -split '=',2
  if ($pair.Length -eq 2) {
    railway variables set "$($pair[0])=$($pair[1])" --service tradingclaw-main --skip-deploys
    railway variables set "$($pair[0])=$($pair[1])" --service tradingclaw-light --skip-deploys
    railway variables set "$($pair[0])=$($pair[1])" --service tradingclaw-ultra --skip-deploys
  }
}
```

## 4) Role-specific variables

Set a shared secret once and reuse on all 3 services:

```bash
railway variables set ESCALATION_SHARED_SECRET="replace-with-random-secret" --service tradingclaw-main --skip-deploys
railway variables set ESCALATION_SHARED_SECRET="replace-with-random-secret" --service tradingclaw-light --skip-deploys
railway variables set ESCALATION_SHARED_SECRET="replace-with-random-secret" --service tradingclaw-ultra --skip-deploys
railway variables set WEBHOOK_SHARED_SECRET="replace-with-random-secret" --service tradingclaw-main --skip-deploys
railway variables set WEBHOOK_SHARED_SECRET="replace-with-random-secret" --service tradingclaw-light --skip-deploys
railway variables set WEBHOOK_SHARED_SECRET="replace-with-random-secret" --service tradingclaw-ultra --skip-deploys
railway variables set WEBHOOK_REQUIRE_SHARED_SECRET="true" --service tradingclaw-main --skip-deploys
railway variables set WEBHOOK_REQUIRE_SHARED_SECRET="true" --service tradingclaw-light --skip-deploys
railway variables set WEBHOOK_REQUIRE_SHARED_SECRET="true" --service tradingclaw-ultra --skip-deploys
```

Main:

```bash
railway variables set TRADING_RUNTIME_ROLE="main" --service tradingclaw-main --skip-deploys
railway variables set TELEGRAM_ENABLED="true" --service tradingclaw-main --skip-deploys
railway variables set DAILY_LOG_DELIVERY_ENABLED="true" --service tradingclaw-main --skip-deploys
```

Light:

```bash
railway variables set TRADING_RUNTIME_ROLE="light" --service tradingclaw-light --skip-deploys
railway variables set TELEGRAM_ENABLED="false" --service tradingclaw-light --skip-deploys
railway variables set DAILY_LOG_DELIVERY_ENABLED="false" --service tradingclaw-light --skip-deploys
railway variables set ESCALATION_MAIN_URL="https://<main-domain>/internal/escalate/main" --service tradingclaw-light --skip-deploys
```

Ultra:

```bash
railway variables set TRADING_RUNTIME_ROLE="ultra" --service tradingclaw-ultra --skip-deploys
railway variables set TELEGRAM_ENABLED="false" --service tradingclaw-ultra --skip-deploys
railway variables set DAILY_LOG_DELIVERY_ENABLED="false" --service tradingclaw-ultra --skip-deploys
railway variables set ESCALATION_LIGHT_URL="https://<light-domain>/internal/escalate/light" --service tradingclaw-ultra --skip-deploys
```

## 5) Budget profile variables

```bash
railway variables set RAILWAY_BUDGET_MODE="true" --service tradingclaw-main --skip-deploys
railway variables set RAILWAY_BUDGET_MODE="true" --service tradingclaw-light --skip-deploys
railway variables set RAILWAY_BUDGET_MODE="true" --service tradingclaw-ultra --skip-deploys
railway variables set TRADING_CYCLE_HOURS="1" --service tradingclaw-main --skip-deploys
railway variables set LIGHT_CYCLE_INTERVAL_MINUTES="5" --service tradingclaw-light --skip-deploys
railway variables set ULTRA_LIGHT_CYCLE_INTERVAL_MINUTES="1" --service tradingclaw-ultra --skip-deploys
railway variables set HEARTBEAT_ENABLED="false" --service tradingclaw-main --skip-deploys
railway variables set HEARTBEAT_ENABLED="false" --service tradingclaw-light --skip-deploys
railway variables set HEARTBEAT_ENABLED="false" --service tradingclaw-ultra --skip-deploys
```

## 6) Deploy

```bash
railway up --service tradingclaw-main --detach
railway up --service tradingclaw-light --detach
railway up --service tradingclaw-ultra --detach
```

## 7) Verify

```bash
railway logs --service tradingclaw-main --lines 80
railway logs --service tradingclaw-light --lines 80
railway logs --service tradingclaw-ultra --lines 80
```

Check for:
- `Runtime Role: main/light/ultra`
- `Active window: Mon-Fri 09:30-16:00 (America/New_York)`
- no Telegram 409 conflict

## 8) Google Drive logs (optional)

Set these on `tradingclaw-main` (or all services if wanted):

```bash
railway variables set GOOGLE_DRIVE_LOG_UPLOAD_ENABLED="true" --service tradingclaw-main --skip-deploys
railway variables set GOOGLE_DRIVE_FOLDER_ID="<folder-id>" --service tradingclaw-main --skip-deploys
railway variables set GOOGLE_SERVICE_ACCOUNT_EMAIL="<service-account-email>" --service tradingclaw-main --skip-deploys
railway variables set GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="<private-key-with-\\n>" --service tradingclaw-main --skip-deploys
railway variables set DELETE_LOCAL_LOG_AFTER_UPLOAD="true" --service tradingclaw-main --skip-deploys
```

Then redeploy the service.

## Cost note

Railway does not expose `0.05 vCPU` hard pinning via CLI for this setup. Cost control is achieved by:
- production build (no `tsx watch` in container),
- split roles (main/light/ultra),
- budget mode defaults,
- US market-hours-only scheduling,
- disabled nonessential background jobs.

## Auto start/stop by market hours

This repo includes:
- `.github/workflows/railway-market-hours.yml`

Behavior:
- Every 10 minutes it checks market status.
- During market open -> services are started (if currently down).
- Outside market -> services are stopped.
- Uses Alpaca `/v2/clock` when `ALPACA_API_KEY` + `ALPACA_API_SECRET` are set in GitHub Secrets.
- Falls back to static ET window (Mon-Fri, 09:30-16:00 ET) if Alpaca secrets are missing.

Required GitHub repository secrets:
- `RAILWAY_TOKEN`
- `RAILWAY_PROJECT_ID` (for `tradingclaw-budget`: `32cbb877-ae1b-4bbc-a7e5-8ecdc9ed8533`)
- optional but recommended for holiday-accurate open/close:
  - `ALPACA_API_KEY`
  - `ALPACA_API_SECRET`

Manual trigger:
- GitHub Actions -> `Railway Market Power Schedule` -> Run workflow
- input `action`: `auto`, `up`, or `down`
