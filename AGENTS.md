# AGENTS.md - TradingClaw Betriebsanleitung (Railway)

Diese Datei ist der zentrale Leitfaden fuer Menschen und Coding-Agents in diesem Repository.
Sie dokumentiert, wie TradingClaw produktiv betrieben wird, wie der Markt-Autostart funktioniert und wie Kosten niedrig bleiben.

## 1) Architektur und Rollen

TradingClaw laeuft als 3 getrennte Railway-Services:

- `tradingclaw-main`
  - `TRADING_RUNTIME_ROLE=main`
  - Telegram Polling an (`TELEGRAM_ENABLED=true`)
  - Main Cycle + Daily Reflection
- `tradingclaw-light`
  - `TRADING_RUNTIME_ROLE=light`
  - Telegram Polling aus (`TELEGRAM_ENABLED=false`)
  - Light Cycle (Exit/Risk) + Eskalation zu Main
- `tradingclaw-ultra`
  - `TRADING_RUNTIME_ROLE=ultra`
  - Telegram Polling aus (`TELEGRAM_ENABLED=false`)
  - Ultra-Light Cycle + Eskalation zu Light (Fallback Main)

Wichtig: Nur `main` darf Telegram long polling machen. Sonst entsteht Telegram `409 getUpdates conflict`.

## 2) Marktzeiten und Montag-Autostart

Engine-Zeitfenster im Code:

- US Marktzeit: `America/New_York`
- Aktiv: Montag-Freitag, 09:30-16:00 ET

Fuer Deutschland (Europa/Berlin) gilt:

- **Montag, 9. Maerz 2026** startet US-Markt um **14:30 CET**
- Nach der deutschen Sommerzeit-Umstellung (ab 29. Maerz 2026) startet der US-Markt um **15:30 CEST**

Services muessen ausserhalb der Marktzeit nicht laufen.
Auto-Start/Stop wird ueber GitHub Actions erzwungen (siehe Abschnitt 6).

## 3) Cycle-Frequenzen (Produktiv)

- Main Cycle: jede 1 Stunde (`TRADING_CYCLE_HOURS=1`)
- Light Cycle: alle 5 Minuten (`LIGHT_CYCLE_INTERVAL_MINUTES=5`)
- Ultra-Light Cycle: jede 1 Minute (`ULTRA_LIGHT_CYCLE_INTERVAL_MINUTES=1`)
- Daily Reflection: 15:55 ET (werktags)
- Weekend Weekly Review: aus bei `RAILWAY_BUDGET_MODE=true`

## 4) Low-RAM-Modus (Kostenoptimierung)

Der teuerste Faktor ist RAM. Deshalb gelten produktiv folgende Regeln:

- `main`: `MCP_ENABLED=true`
- `light`: `MCP_ENABLED=false`
- `ultra`: `MCP_ENABLED=false`

Implementiert im Code:

- `light`/`ultra` starten keinen schweren Telegram-Polling-Stack
- `light`/`ultra` nutzen nur einen leichten Telegram-Outbound-Channel fuer Notifications
- schwere Agent-/Tool-Ladepfade werden lazy geladen und nur auf `main` genutzt

Relevante Dateien:

- `src/index.ts`
- `src/config.ts`
- `src/channels/telegram-api-channel.ts`

## 5) Eskalationspfad

Fast-Cycle Eskalation:

- ultra -> light: `/internal/escalate/light`
- light -> main: `/internal/escalate/main`

Absicherung:

- `WEBHOOK_SHARED_SECRET`
- `WEBHOOK_REQUIRE_SHARED_SECRET=true`
- `ESCALATION_SHARED_SECRET` (oder Fallback auf Webhook Secret)

## 6) Automatisches Hoch-/Runterfahren (wichtig)

Workflow-Datei:

- `.github/workflows/railway-market-hours.yml`

Verhalten:

- laeuft alle 10 Minuten (`cron: */10 * * * *`)
- entscheidet `up` oder `down`
- nutzt Alpaca Clock (`/v2/clock`) wenn API-Secrets gesetzt sind
- faellt sonst auf statisches ET-Zeitfenster Mo-Fr 09:30-16:00 zurueck
- startet alle 3 Services bei Markt offen
- faehrt alle 3 Services bei Markt zu herunter

Pflicht-GitHub-Secrets:

- `RAILWAY_TOKEN`
- `RAILWAY_PROJECT_ID`

Empfohlen fuer feiertagsgenaue Marktlogik:

- `ALPACA_API_KEY`
- `ALPACA_API_SECRET`

## 7) Notfall- und Fallback-Befehle

Wenn Auto-Start Montag nicht ausloest:

1. GitHub Actions -> `Railway Market Power Schedule` manuell starten mit `action=up`
2. Oder lokal:

```powershell
railway up --service tradingclaw-main --environment production --detach
railway up --service tradingclaw-light --environment production --detach
railway up --service tradingclaw-ultra --environment production --detach
```

Wenn sofort Kosten gestoppt werden muessen:

```powershell
railway down --service tradingclaw-main --environment production --yes
railway down --service tradingclaw-light --environment production --yes
railway down --service tradingclaw-ultra --environment production --yes
```

Status pruefen:

```powershell
railway service status --service tradingclaw-main --environment production
railway service status --service tradingclaw-light --environment production
railway service status --service tradingclaw-ultra --environment production
```

## 8) Telegram Benachrichtigungen

`main` kann senden:

- Startup-Info
- Cycle Start
- Cycle Ergebnis
- Fast-Cycle Updates
- Trade Events
- Token Usage Snapshot

Wichtige ENV-Schalter:

- `TELEGRAM_NOTIFY_CYCLE_RESULTS`
- `TELEGRAM_NOTIFY_CYCLE_STARTS`
- `TELEGRAM_NOTIFY_TRADE_EVENTS`
- `TELEGRAM_NOTIFY_FAST_CYCLE_SKIPS`
- `TELEGRAM_NOTIFY_TOKEN_USAGE`

## 9) Deploy-Standard fuer Agents

Vor Deploy:

1. `npm run build`
2. sicherstellen, dass keine Secrets im Commit liegen
3. falls Trading-Logik geaendert wurde: Schedule + Rollentrennung gegenpruefen

Deploy:

1. push nach `main`
2. Railway Deploy je Service oder auf Auto-Workflow warten
3. Logs pruefen (`railway logs --service <name> --environment production --lines 80`)

Erwartete Log-Signale:

- Runtime role korrekt (`main`/`light`/`ultra`)
- Marktzeitfenster korrekt (`Mon-Fri 09:30-16:00 America/New_York`)
- kein Telegram 409 Konflikt
- `light`/`ultra`: `MCP enabled: false` und `low-memory Telegram outbound mode`

## 10) Sicherheit

- Niemals `.env`, Tokens, API-Keys oder Private Keys committen.
- Keine produktiven Secrets in Issues/PR-Kommentaren teilen.
- `.env.example` ist die einzige Vorlage fuer neue Variablen.

## 11) Referenzen

- `RAILWAY_SOP.md` (Deploy und Operations)
- `.github/workflows/railway-market-hours.yml`
- `.github/workflows/railway-teststart-now.yml`
- `src/trading/engine.ts`
- `src/automation/webhooks.ts`
