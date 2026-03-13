param(
    [string]$Environment = "production",
    [string]$Paper100kService = "tradingclawpaper100kusd",
    [string]$MiniService = "tradingclaw-mini",
    [string]$SchedulerService = "market-scheduler",
    [string]$Paper100kTelegramWebhookUrl = "",
    [string]$MiniTelegramWebhookUrl = "",
    [string]$WebhookSharedSecret = "",
    [string]$SchedulerRailwayToken = "",
    [string]$SchedulerProjectId = "32cbb877-ae1b-4bbc-a7e5-8ecdc9ed8533",
    [string]$SchedulerEnvironmentId = "6308f432-7178-4dad-b06d-0ed610a2d4e0",
    [string]$SchedulerTargetServices = "tradingclawpaper100kusd,tradingclaw-mini"
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

$tradingServices = @($Paper100kService, $MiniService)

foreach ($service in $tradingServices) {
    Set-RailwayVar -Service $service -Name "RAILWAY_BUDGET_MODE" -Value "true"
    Set-RailwayVar -Service $service -Name "HEARTBEAT_ENABLED" -Value "false"
    Set-RailwayVar -Service $service -Name "MARKET_CLOSED_EXIT_ENABLED" -Value "true"
    Set-RailwayVar -Service $service -Name "MARKET_CLOSED_EXIT_CHECK_MINUTES" -Value "5"
    Set-RailwayVar -Service $service -Name "WEBHOOK_REQUIRE_SHARED_SECRET" -Value "false"
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
}

Set-RailwayVar -Service $Paper100kService -Name "TRADING_RUNTIME_ROLE" -Value "all"
Set-RailwayVar -Service $Paper100kService -Name "TELEGRAM_ENABLED" -Value "true"
Set-RailwayVar -Service $Paper100kService -Name "DAILY_LOG_DELIVERY_ENABLED" -Value "true"
Set-RailwayVar -Service $Paper100kService -Name "MCP_ENABLED" -Value "true"
Set-RailwayVar -Service $Paper100kService -Name "TRADING_CYCLE_HOURS" -Value "1"
Set-RailwayVar -Service $Paper100kService -Name "LIGHT_CYCLE_ENABLED" -Value "true"
Set-RailwayVar -Service $Paper100kService -Name "LIGHT_CYCLE_INTERVAL_MINUTES" -Value "5"
Set-RailwayVar -Service $Paper100kService -Name "ULTRA_LIGHT_CYCLE_ENABLED" -Value "true"
Set-RailwayVar -Service $Paper100kService -Name "ULTRA_LIGHT_CYCLE_INTERVAL_MINUTES" -Value "1"
if (-not [string]::IsNullOrWhiteSpace($Paper100kTelegramWebhookUrl)) {
    Set-RailwayVar -Service $Paper100kService -Name "TELEGRAM_WEBHOOK_ENABLED" -Value "true"
    Set-RailwayVar -Service $Paper100kService -Name "TELEGRAM_WEBHOOK_URL" -Value $Paper100kTelegramWebhookUrl
    if (-not [string]::IsNullOrWhiteSpace($WebhookSharedSecret)) {
        Set-RailwayVar -Service $Paper100kService -Name "TELEGRAM_WEBHOOK_SECRET_TOKEN" -Value $WebhookSharedSecret
    }
}

Set-RailwayVar -Service $MiniService -Name "TRADING_RUNTIME_ROLE" -Value "main"
Set-RailwayVar -Service $MiniService -Name "TELEGRAM_ENABLED" -Value "true"
Set-RailwayVar -Service $MiniService -Name "DAILY_LOG_DELIVERY_ENABLED" -Value "false"
Set-RailwayVar -Service $MiniService -Name "MCP_ENABLED" -Value "false"
Set-RailwayVar -Service $MiniService -Name "TRADING_CYCLE_HOURS" -Value "1"
Set-RailwayVar -Service $MiniService -Name "LIGHT_CYCLE_ENABLED" -Value "false"
Set-RailwayVar -Service $MiniService -Name "ULTRA_LIGHT_CYCLE_ENABLED" -Value "false"
Set-RailwayVar -Service $MiniService -Name "ALPACA_ALLOW_FRACTIONAL_SHARES" -Value "true"
Set-RailwayVar -Service $MiniService -Name "DAILY_LOSS_LIMIT_AMOUNT" -Value "0.5"
Set-RailwayVar -Service $MiniService -Name "DAILY_LOSS_LIMIT_MIN_PERCENT" -Value "0.05"
if (-not [string]::IsNullOrWhiteSpace($MiniTelegramWebhookUrl)) {
    Set-RailwayVar -Service $MiniService -Name "TELEGRAM_WEBHOOK_ENABLED" -Value "true"
    Set-RailwayVar -Service $MiniService -Name "TELEGRAM_WEBHOOK_URL" -Value $MiniTelegramWebhookUrl
    if (-not [string]::IsNullOrWhiteSpace($WebhookSharedSecret)) {
        Set-RailwayVar -Service $MiniService -Name "TELEGRAM_WEBHOOK_SECRET_TOKEN" -Value $WebhookSharedSecret
    }
}

Set-RailwayVar -Service $SchedulerService -Name "RAILWAY_PROJECT_ID" -Value $SchedulerProjectId
Set-RailwayVar -Service $SchedulerService -Name "RAILWAY_ENVIRONMENT_ID" -Value $SchedulerEnvironmentId
Set-RailwayVar -Service $SchedulerService -Name "MARKET_SCHEDULER_TARGET_SERVICES" -Value $SchedulerTargetServices
Set-RailwayVar -Service $SchedulerService -Name "MARKET_TIMEZONE" -Value "America/New_York"
Set-RailwayVar -Service $SchedulerService -Name "MARKET_OPEN_MINUTES" -Value "570"
Set-RailwayVar -Service $SchedulerService -Name "MARKET_CLOSE_MINUTES" -Value "960"
Set-RailwayVar -Service $SchedulerService -Name "MARKET_SCHEDULER_REPAIR_DELAY_MS" -Value "20000"
Set-RailwayVar -Service $SchedulerService -Name "MARKET_SCHEDULER_SKIP_REPAIR" -Value "false"
Set-OptionalRailwayVar -Service $SchedulerService -Name "RAILWAY_TOKEN" -Value $SchedulerRailwayToken

Write-Host ""
Write-Host "Applied current production defaults to Railway variables."
Write-Host "Still verify these manually:"
Write-Host "- Telegram tokens / chat allow-lists on both trading services"
Write-Host "- Alpaca credentials on both trading services and scheduler"
Write-Host "- Railway token present on market-scheduler"
