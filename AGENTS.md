# AGENTS.md - TradingClaw Betriebsanleitung (Railway)

Diese Datei ist der zentrale Leitfaden fuer Menschen und Coding-Agents in diesem Repository.
Sie dokumentiert, wie TradingClaw aktuell produktiv betrieben wird, wie der Markt-Autostart funktioniert und wie Kosten niedrig bleiben.

## 1) Architektur und Rollen

TradingClaw laeuft produktiv als 2 getrennte Railway-Services plus 1 Scheduler:

- `tradingclawpaper100kusd`
  - `TRADING_RUNTIME_ROLE=all`
  - ein einzelner Service fuer das 100k-Paper-Konto
  - Main Cycle + Light Cycle + Ultra-Light Cycle in einem Prozess
  - Telegram aktiv
  - `MCP_ENABLED=true`
- `tradingclaw-mini`
  - `TRADING_RUNTIME_ROLE=main`
  - einzelner Service fuer das 10-USD-Paper-Konto
  - Main Cycle only
  - eigener Telegram-Bot
  - `MCP_ENABLED=false`
- `market-scheduler`
  - Railway Function / Cron-Job
  - startet und stoppt beide Trading-Services direkt ueber die Railway GraphQL API
  - laeuft alle 10 Minuten

Die frueheren Services `tradingclaw-main`, `tradingclaw-light` und `tradingclaw-ultra` sind produktiv ersetzt und sollen nicht wiederverwendet werden.

## 2) Marktzeiten

Engine-Zeitfenster im Code:

- US Marktzeit: `America/New_York`
- Aktiv: Montag-Freitag, 09:30-16:00 ET

Fuer Deutschland (Europa/Berlin) gilt:

- **Montag, 9. Maerz 2026** startet US-Markt um **14:30 CET**
- Nach der deutschen Sommerzeit-Umstellung (ab 29. Maerz 2026) startet der US-Markt um **15:30 CEST**

Ausserhalb der Marktzeit sollen beide Trading-Services gestoppt sein, um Kosten zu sparen.

## 3) Cycle-Frequenzen (Produktiv)

`tradingclawpaper100kusd`
- Main Cycle: jede 1 Stunde (`TRADING_CYCLE_HOURS=1`)
- Light Cycle: alle 5 Minuten (`LIGHT_CYCLE_INTERVAL_MINUTES=5`)
- Ultra-Light Cycle: jede 1 Minute (`ULTRA_LIGHT_CYCLE_INTERVAL_MINUTES=1`)
- Daily Reflection: 15:55 ET (werktags)

`tradingclaw-mini`
- Main Cycle: jede 1 Stunde (`TRADING_CYCLE_HOURS=1`)
- Light Cycle: aus
- Ultra-Light Cycle: aus
- Daily Reflection: 15:55 ET (werktags)

## 4) Low-RAM-Modus (Kostenoptimierung)

Produktive Regeln:

- `tradingclawpaper100kusd`: `RAILWAY_BUDGET_MODE=true`, `MCP_ENABLED=true`
- `tradingclaw-mini`: `RAILWAY_BUDGET_MODE=true`, `MCP_ENABLED=false`
- `market-scheduler`: nur leichter Cron-Lauf, keine Telegram-/MCP-/Trading-Engine

Wichtige Effekte:

- ausserhalb der Marktzeit beendet sich jeder Trading-Service selbst
- Scheduler weckt Services nur waehrend des Marktes wieder auf
- `mini` nutzt Fractional Trading fuer das kleine Konto

## 5) Automatisches Hoch-/Runterfahren (wichtig)

Primaere Steuerung:

- `railway/market-scheduler.mjs`

Verhalten:

- Railway Cron laeuft alle 10 Minuten
- nutzt Alpaca Clock (`/v2/clock`) wenn API-Secrets gesetzt sind
- faellt sonst auf statisches ET-Zeitfenster Mo-Fr 09:30-16:00 zurueck
- startet `tradingclawpaper100kusd` und `tradingclaw-mini` bei Markt offen
- stoppt beide Services bei Markt zu
- macht bei `up` einen zweiten Repair-Pass und startet fehlerhafte/stoppte Deployments erneut

Wichtige ENV-Variablen fuer den Scheduler:

- `RAILWAY_TOKEN`
- `RAILWAY_PROJECT_ID`
- `RAILWAY_ENVIRONMENT_ID`
- `MARKET_SCHEDULER_TARGET_SERVICES`
- optional fuer feiertagsgenaue Marktlogik:
  - `ALPACA_API_KEY`
  - `ALPACA_API_SECRET`

GitHub-Workflows sind nur noch manueller Fallback und nicht mehr der primaere Autostart.

## 6) Telegram Benachrichtigungen

`tradingclawpaper100kusd` kann senden:

- Startup-Info
- Cycle Start
- Cycle Ergebnis
- Fast-Cycle Updates
- Trade Events
- Token Usage Snapshot

`tradingclaw-mini` kann senden:

- Startup-Info
- Cycle Start
- Cycle Ergebnis
- Trade Events

Wichtige ENV-Schalter:

- `TELEGRAM_NOTIFY_CYCLE_RESULTS`
- `TELEGRAM_NOTIFY_CYCLE_STARTS`
- `TELEGRAM_NOTIFY_TRADE_EVENTS`
- `TELEGRAM_NOTIFY_FAST_CYCLE_SKIPS`
- `TELEGRAM_NOTIFY_TOKEN_USAGE`

## 7) Notfall- und Fallback-Befehle

Wenn der Scheduler nicht ausloest:

1. Railway Function `market-scheduler` manuell ausfuehren oder neu deployen
2. Oder lokal:

```powershell
railway up --service tradingclawpaper100kusd --environment production --detach
railway up --service tradingclaw-mini --environment production --detach
```

Wenn sofort Kosten gestoppt werden muessen:

```powershell
railway down --service tradingclawpaper100kusd --environment production --yes
railway down --service tradingclaw-mini --environment production --yes
```

Status pruefen:

```powershell
railway service status --service tradingclawpaper100kusd --environment production
railway service status --service tradingclaw-mini --environment production
```

## 8) Deploy-Standard fuer Agents

Vor Deploy:

1. `npm run build`
2. sicherstellen, dass keine Secrets im Commit liegen
3. falls Trading-Logik geaendert wurde: Marktfenster + Scheduler gegenpruefen

Deploy:

1. push nach `main`
2. Railway Deploy je Trading-Service oder Scheduler-Funktion
3. Logs pruefen (`railway logs --service <name> --environment production --lines 80`)

Erwartete Log-Signale:

- `tradingclawpaper100kusd`: `Runtime role: all`
- `tradingclaw-mini`: `Runtime role: main`
- Marktzeitfenster korrekt (`Mon-Fri 09:30-16:00 America/New_York`)
- ausserhalb der Marktzeit: `Startup guard: outside US market hours`

## 9) Sicherheit

- Niemals `.env`, Tokens, API-Keys oder Private Keys committen.
- Keine produktiven Secrets in Issues/PR-Kommentaren teilen.
- `.env.example` ist die einzige Vorlage fuer neue Variablen.
- Wenn Secrets im Chat/Log auftauchen, nach dem Einsatz rotieren.

## 10) Referenzen

- `RAILWAY_SOP.md`
- `railway/market-scheduler.mjs`
- `.github/workflows/railway-market-hours.yml`
- `.github/workflows/railway-teststart-now.yml`
- `src/index.ts`
- `src/trading/engine.ts`
- `src/automation/webhooks.ts`
