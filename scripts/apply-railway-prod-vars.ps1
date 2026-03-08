param(
    [string]$Environment = "production",
    [string]$MainService = "tradingclaw-main",
    [string]$LightService = "tradingclaw-light",
    [string]$UltraService = "tradingclaw-ultra",
    [string]$MainTelegramWebhookUrl = "",
    [string]$WebhookSharedSecret = "",
    [string]$EscalationSharedSecret = "",
    [string]$EscalationMainUrl = "",
    [string]$EscalationLightUrl = ""
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command railway -ErrorAction SilentlyContinue)) {
    throw "Railway CLI not found. Install it first with: npm install -g @railway/cli"
}

function Set-RailwayVar {
    param(
        [Parameter(Mandatory = $true)][string]$Service,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )

    Write-Host "[$Service] $Name=$Value"
    railway variables set "$Name=$Value" --service $Service --environment $Environment --skip-deploys | Out-Host
}

function Set-OptionalRailwayVar {
    param(
        [Parameter(Mandatory = $true)][string]$Service,
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        Write-Host "[$Service] skipping $Name (no value provided)"
        return
    }

    Set-RailwayVar -Service $Service -Name $Name -Value $Value
}

$services = @($MainService, $LightService, $UltraService)

foreach ($service in $services) {
    Set-RailwayVar -Service $service -Name "RAILWAY_BUDGET_MODE" -Value "true"
    Set-RailwayVar -Service $service -Name "LIGHT_CYCLE_ENABLED" -Value "true"
    Set-RailwayVar -Service $service -Name "ULTRA_LIGHT_CYCLE_ENABLED" -Value "true"
    Set-RailwayVar -Service $service -Name "HEARTBEAT_ENABLED" -Value "false"
    Set-RailwayVar -Service $service -Name "MARKET_CLOSED_EXIT_ENABLED" -Value "true"
    Set-RailwayVar -Service $service -Name "MARKET_CLOSED_EXIT_CHECK_MINUTES" -Value "5"
    Set-RailwayVar -Service $service -Name "TELEGRAM_WEBHOOK_ENABLED" -Value "false"
    Set-RailwayVar -Service $service -Name "WEBHOOK_REQUIRE_SHARED_SECRET" -Value "true"
    Set-RailwayVar -Service $service -Name "TELEGRAM_NOTIFY_CYCLE_RESULTS" -Value "true"
    Set-RailwayVar -Service $service -Name "TELEGRAM_NOTIFY_CYCLE_STARTS" -Value "true"
    Set-RailwayVar -Service $service -Name "TELEGRAM_NOTIFY_TRADE_EVENTS" -Value "true"
    Set-RailwayVar -Service $service -Name "TELEGRAM_NOTIFY_FAST_CYCLE_SKIPS" -Value "true"
    Set-RailwayVar -Service $service -Name "TELEGRAM_NOTIFY_TOKEN_USAGE" -Value "true"
    Set-RailwayVar -Service $service -Name "APP_FATAL_RESTART_ENABLED" -Value "true"
    Set-RailwayVar -Service $service -Name "APP_FATAL_RESTART_BASE_DELAY_MS" -Value "5000"
    Set-RailwayVar -Service $service -Name "APP_FATAL_RESTART_MAX_DELAY_MS" -Value "60000"
    Set-RailwayVar -Service $service -Name "APP_FATAL_RESTART_MAX_ATTEMPTS" -Value "0"
    Set-OptionalRailwayVar -Service $service -Name "WEBHOOK_SHARED_SECRET" -Value $WebhookSharedSecret
    Set-OptionalRailwayVar -Service $service -Name "ESCALATION_SHARED_SECRET" -Value $EscalationSharedSecret
}

Set-RailwayVar -Service $MainService -Name "TRADING_RUNTIME_ROLE" -Value "main"
Set-RailwayVar -Service $MainService -Name "TELEGRAM_ENABLED" -Value "true"
Set-RailwayVar -Service $MainService -Name "DAILY_LOG_DELIVERY_ENABLED" -Value "true"
Set-RailwayVar -Service $MainService -Name "MCP_ENABLED" -Value "true"
Set-RailwayVar -Service $MainService -Name "TRADING_CYCLE_HOURS" -Value "1"
if (-not [string]::IsNullOrWhiteSpace($MainTelegramWebhookUrl)) {
    Set-RailwayVar -Service $MainService -Name "TELEGRAM_WEBHOOK_ENABLED" -Value "true"
    Set-RailwayVar -Service $MainService -Name "TELEGRAM_WEBHOOK_URL" -Value $MainTelegramWebhookUrl
    if (-not [string]::IsNullOrWhiteSpace($WebhookSharedSecret)) {
        Set-RailwayVar -Service $MainService -Name "TELEGRAM_WEBHOOK_SECRET_TOKEN" -Value $WebhookSharedSecret
    }
}

Set-RailwayVar -Service $LightService -Name "TRADING_RUNTIME_ROLE" -Value "light"
Set-RailwayVar -Service $LightService -Name "TELEGRAM_ENABLED" -Value "false"
Set-RailwayVar -Service $LightService -Name "DAILY_LOG_DELIVERY_ENABLED" -Value "false"
Set-RailwayVar -Service $LightService -Name "MCP_ENABLED" -Value "false"
Set-RailwayVar -Service $LightService -Name "LIGHT_CYCLE_INTERVAL_MINUTES" -Value "5"
Set-OptionalRailwayVar -Service $LightService -Name "ESCALATION_MAIN_URL" -Value $EscalationMainUrl

Set-RailwayVar -Service $UltraService -Name "TRADING_RUNTIME_ROLE" -Value "ultra"
Set-RailwayVar -Service $UltraService -Name "TELEGRAM_ENABLED" -Value "false"
Set-RailwayVar -Service $UltraService -Name "DAILY_LOG_DELIVERY_ENABLED" -Value "false"
Set-RailwayVar -Service $UltraService -Name "MCP_ENABLED" -Value "false"
Set-RailwayVar -Service $UltraService -Name "ULTRA_LIGHT_CYCLE_INTERVAL_MINUTES" -Value "1"
Set-OptionalRailwayVar -Service $UltraService -Name "ESCALATION_LIGHT_URL" -Value $EscalationLightUrl

Write-Host ""
Write-Host "Applied AGENTS.md production defaults to Railway variables."
Write-Host "Still verify these manually:"
Write-Host "- GitHub secrets: RAILWAY_TOKEN, RAILWAY_PROJECT_ID, ALPACA_API_KEY, ALPACA_API_SECRET"
Write-Host "- Escalation URLs set on light and ultra"
Write-Host "- Shared secrets set consistently on all three services"
