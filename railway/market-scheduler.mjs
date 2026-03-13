const DEFAULT_PROJECT_ID = "32cbb877-ae1b-4bbc-a7e5-8ecdc9ed8533";
const DEFAULT_ENVIRONMENT_ID = "6308f432-7178-4dad-b06d-0ed610a2d4e0";
const DEFAULT_TIMEZONE = "America/New_York";
const DEFAULT_OPEN_MINUTES = 9 * 60 + 30;
const DEFAULT_CLOSE_MINUTES = 16 * 60;
const DEFAULT_TARGET_SERVICES = ["tradingclawpaper100kusd", "tradingclaw-mini"];
const RAILWAY_GRAPHQL_URL = "https://backboard.railway.app/graphql/v2";
const DEFAULT_ALPACA_BASE_URL = "https://paper-api.alpaca.markets";

function requireEnv(name, fallback) {
    const value = (process.env[name] ?? fallback ?? "").trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function parseBooleanEnv(name, fallback = false) {
    const raw = process.env[name];
    if (raw == null) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
}

function parseCsv(raw, fallback = []) {
    const source = (raw ?? "").trim();
    if (!source) return [...fallback];
    return source
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
}

function normalizeAction(raw) {
    const value = (raw ?? "").trim().toLowerCase();
    return value === "up" || value === "down" ? value : undefined;
}

function getEtParts(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
    const parts = Object.fromEntries(
        formatter
            .formatToParts(now)
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value]),
    );
    const weekday = String(parts.weekday ?? "Sun");
    const hour = Number(parts.hour ?? "0");
    const minute = Number(parts.minute ?? "0");
    const second = Number(parts.second ?? "0");
    return {
        weekday,
        hour,
        minute,
        second,
        isoDate: `${parts.year}-${parts.month}-${parts.day}`,
        isoTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`,
    };
}

function getStaticMarketDecision() {
    const timeZone = process.env.MARKET_TIMEZONE ?? DEFAULT_TIMEZONE;
    const openMinutes = Number(process.env.MARKET_OPEN_MINUTES ?? DEFAULT_OPEN_MINUTES);
    const closeMinutes = Number(process.env.MARKET_CLOSE_MINUTES ?? DEFAULT_CLOSE_MINUTES);
    const parts = getEtParts(new Date(), timeZone);
    const weekdayOpen = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(parts.weekday);
    const minutes = (parts.hour * 60) + parts.minute;
    const action = weekdayOpen && minutes >= openMinutes && minutes < closeMinutes ? "up" : "down";

    return {
        action,
        source: "static-et-window",
        marketTime: `${parts.isoDate}T${parts.isoTime} ${timeZone}`,
        details: `weekday=${parts.weekday} minutes=${minutes} open=${openMinutes} close=${closeMinutes}`,
    };
}

async function getAlpacaClockDecision() {
    const apiKey = (process.env.ALPACA_API_KEY ?? "").trim();
    const apiSecret = (process.env.ALPACA_API_SECRET ?? "").trim();
    if (!apiKey || !apiSecret) return null;

    const baseUrl = (process.env.ALPACA_BASE_URL ?? DEFAULT_ALPACA_BASE_URL).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/v2/clock`, {
        headers: {
            "APCA-API-KEY-ID": apiKey,
            "APCA-API-SECRET-KEY": apiSecret,
            "Content-Type": "application/json",
        },
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Alpaca clock lookup failed: ${response.status} ${response.statusText} ${body}`.trim());
    }

    const payload = await response.json();
    return {
        action: payload?.is_open ? "up" : "down",
        source: "alpaca-clock",
        marketTime: payload?.timestamp ?? new Date().toISOString(),
        details: `is_open=${Boolean(payload?.is_open)}`,
    };
}

async function decideAction() {
    const forced = normalizeAction(process.env.MARKET_SCHEDULER_FORCE_ACTION);
    if (forced) {
        return {
            action: forced,
            source: "forced",
            marketTime: new Date().toISOString(),
            details: "MARKET_SCHEDULER_FORCE_ACTION override",
        };
    }

    try {
        const alpaca = await getAlpacaClockDecision();
        if (alpaca) return alpaca;
    } catch (error) {
        console.error(`[market-scheduler] Alpaca clock failed, falling back to static ET window: ${error instanceof Error ? error.message : String(error)}`);
    }

    return getStaticMarketDecision();
}

async function railwayGraphql(query, variables = {}) {
    const token = requireEnv("RAILWAY_TOKEN", process.env.RAILWAY_API_TOKEN);
    const response = await fetch(RAILWAY_GRAPHQL_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Railway GraphQL HTTP ${response.status}: ${response.statusText} ${body}`.trim());
    }

    const payload = await response.json();
    if (payload.errors?.length) {
        throw new Error(payload.errors.map((error) => error.message).join(" | "));
    }

    return payload.data;
}

async function fetchServiceStates(projectId, environmentId) {
    const query = `
        query MarketSchedulerServiceStates($projectId: String!, $environmentId: String!) {
            environment(projectId: $projectId, id: $environmentId) {
                id
                name
                serviceInstances {
                    edges {
                        node {
                            serviceName
                            serviceId
                            environmentId
                            latestDeployment {
                                id
                                status
                                deploymentStopped
                                createdAt
                            }
                        }
                    }
                }
            }
        }
    `;

    const data = await railwayGraphql(query, { projectId, environmentId });
    const environment = data?.environment;
    if (!environment) {
        throw new Error(`Railway environment not found for project=${projectId} environment=${environmentId}`);
    }

    return {
        environmentName: environment.name,
        services: (environment.serviceInstances?.edges ?? []).map((edge) => edge.node),
    };
}

async function restartDeployment(deploymentId) {
    const mutation = `
        mutation MarketSchedulerRestart($id: String!) {
            deploymentRestart(id: $id)
        }
    `;
    const data = await railwayGraphql(mutation, { id: deploymentId });
    return Boolean(data?.deploymentRestart);
}

async function stopDeployment(deploymentId) {
    const mutation = `
        mutation MarketSchedulerStop($id: String!) {
            deploymentStop(id: $id)
        }
    `;
    const data = await railwayGraphql(mutation, { id: deploymentId });
    return Boolean(data?.deploymentStop);
}

function shouldRepairRunningState(service) {
    const deployment = service.latestDeployment;
    if (!deployment?.id) return false;
    if (deployment.deploymentStopped) return true;
    return ["FAILED", "CRASHED", "REMOVED"].includes(String(deployment.status ?? "").toUpperCase());
}

async function syncServiceState(service, action, dryRun) {
    const deployment = service.latestDeployment;
    const name = service.serviceName;

    if (!deployment?.id) {
        console.warn(`[market-scheduler] ${name}: no deployment found, skipping ${action}.`);
        return { service: name, action, outcome: "skipped-no-deployment" };
    }

    const status = String(deployment.status ?? "UNKNOWN").toUpperCase();
    const stopped = Boolean(deployment.deploymentStopped);

    if (action === "up") {
        if (!stopped && !["FAILED", "CRASHED", "REMOVED"].includes(status)) {
            console.log(`[market-scheduler] ${name}: already active (status=${status}, stopped=${stopped}).`);
            return { service: name, action, outcome: "already-up" };
        }

        if (dryRun) {
            console.log(`[market-scheduler] ${name}: dry-run restart of deployment ${deployment.id}.`);
            return { service: name, action, outcome: "dry-run-restart" };
        }

        const ok = await restartDeployment(deployment.id);
        console.log(`[market-scheduler] ${name}: restart ${ok ? "accepted" : "rejected"} for deployment ${deployment.id}.`);
        return { service: name, action, outcome: ok ? "restart-requested" : "restart-rejected" };
    }

    if (stopped) {
        console.log(`[market-scheduler] ${name}: already stopped.`);
        return { service: name, action, outcome: "already-down" };
    }

    if (dryRun) {
        console.log(`[market-scheduler] ${name}: dry-run stop of deployment ${deployment.id}.`);
        return { service: name, action, outcome: "dry-run-stop" };
    }

    const ok = await stopDeployment(deployment.id);
    console.log(`[market-scheduler] ${name}: stop ${ok ? "accepted" : "rejected"} for deployment ${deployment.id}.`);
    return { service: name, action, outcome: ok ? "stop-requested" : "stop-rejected" };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function repairAfterStart(projectId, environmentId, targetNames, dryRun) {
    if (dryRun || parseBooleanEnv("MARKET_SCHEDULER_SKIP_REPAIR", false)) return [];

    const delayMs = Math.max(0, Number(process.env.MARKET_SCHEDULER_REPAIR_DELAY_MS ?? "20000"));
    if (delayMs > 0) {
        console.log(`[market-scheduler] waiting ${Math.round(delayMs / 1000)}s before repair pass...`);
        await sleep(delayMs);
    }

    const latest = await fetchServiceStates(projectId, environmentId);
    const results = [];
    for (const targetName of targetNames) {
        const service = latest.services.find((item) => item.serviceName === targetName);
        if (!service) {
            console.warn(`[market-scheduler] repair pass: service ${targetName} not found.`);
            continue;
        }
        if (!shouldRepairRunningState(service)) {
            console.log(`[market-scheduler] repair pass: ${targetName} looks healthy.`);
            continue;
        }
        const deploymentId = service.latestDeployment?.id;
        if (!deploymentId) continue;
        const ok = await restartDeployment(deploymentId);
        console.log(`[market-scheduler] repair pass: ${targetName} restart ${ok ? "accepted" : "rejected"} for deployment ${deploymentId}.`);
        results.push({ service: targetName, action: "repair-up", outcome: ok ? "restart-requested" : "restart-rejected" });
    }
    return results;
}

async function main() {
    const projectId = requireEnv("RAILWAY_PROJECT_ID", DEFAULT_PROJECT_ID);
    const environmentId = requireEnv("RAILWAY_ENVIRONMENT_ID", DEFAULT_ENVIRONMENT_ID);
    const targetServices = parseCsv(process.env.MARKET_SCHEDULER_TARGET_SERVICES, DEFAULT_TARGET_SERVICES);
    const dryRun = parseBooleanEnv("MARKET_SCHEDULER_DRY_RUN", false);

    const decision = await decideAction();
    console.log(`[market-scheduler] decision=${decision.action} source=${decision.source} market_time=${decision.marketTime} details=${decision.details}`);
    console.log(`[market-scheduler] target services: ${targetServices.join(", ")}`);

    const state = await fetchServiceStates(projectId, environmentId);
    console.log(`[market-scheduler] railway environment=${state.environmentName} (${environmentId}) dry_run=${dryRun}`);

    const results = [];
    for (const targetName of targetServices) {
        const service = state.services.find((item) => item.serviceName === targetName);
        if (!service) {
            console.warn(`[market-scheduler] ${targetName}: service not found in environment ${state.environmentName}.`);
            results.push({ service: targetName, action: decision.action, outcome: "missing-service" });
            continue;
        }
        results.push(await syncServiceState(service, decision.action, dryRun));
    }

    if (decision.action === "up") {
        results.push(...await repairAfterStart(projectId, environmentId, targetServices, dryRun));
    }

    console.log(`[market-scheduler] completed ${decision.action} run.`);
    console.log(JSON.stringify({ decision, results }, null, 2));
}

main().catch((error) => {
    console.error(`[market-scheduler] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
});
