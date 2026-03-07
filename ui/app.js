const POLL_INTERVAL_MS = 4000;

const state = {
    cycleFilter: "all",
};

const elements = {
    heroLive: document.getElementById("hero-live"),
    overviewGeneratedAt: document.getElementById("overview-generated-at"),
    consoleHighlights: document.getElementById("console-highlights"),
    consoleStream: document.getElementById("console-stream"),
    metricGrid: document.getElementById("metric-grid"),
    activitySummary: document.getElementById("activity-summary"),
    runtimeDetails: document.getElementById("runtime-details"),
    positionsCount: document.getElementById("positions-count"),
    positionsBody: document.getElementById("positions-body"),
    ordersCount: document.getElementById("orders-count"),
    ordersBody: document.getElementById("orders-body"),
    cycleTimeline: document.getElementById("cycle-timeline"),
    tradesBody: document.getElementById("trades-body"),
    reflectionCard: document.getElementById("reflection-card"),
    weeklyReviewCard: document.getElementById("weekly-review-card"),
    tokenUsage: document.getElementById("token-usage"),
    todayLogLabel: document.getElementById("today-log-label"),
    cycleLogLabel: document.getElementById("cycle-log-label"),
    todayLog: document.getElementById("today-log"),
    cycleLog: document.getElementById("cycle-log"),
};

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function formatCurrency(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "n/a";
    return new Intl.NumberFormat("de-DE", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
    }).format(amount);
}

function formatNumber(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "n/a";
    return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(amount);
}

function formatDate(value) {
    if (!value) return "n/a";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("de-DE", {
        dateStyle: "short",
        timeStyle: "medium",
    }).format(date);
}

function compactText(value, max = 180) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max - 3)}...`;
}

function prettyJson(value) {
    if (value == null) return "None";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function metricCard(label, value, meta = "") {
    return `
        <article class="metric-card">
            <span class="metric-label">${escapeHtml(label)}</span>
            <div class="metric-value">${escapeHtml(value)}</div>
            <div class="metric-meta">${escapeHtml(meta)}</div>
        </article>
    `;
}

function miniCard(title, text, tone = "") {
    return `
        <article class="mini-card ${tone}">
            <strong>${escapeHtml(title)}</strong>
            <div>${escapeHtml(text || "n/a")}</div>
        </article>
    `;
}

function keyValueRows(items) {
    return items.map(([key, value]) => `
        <div class="kv-row">
            <div class="kv-key">${escapeHtml(key)}</div>
            <div class="kv-value">${escapeHtml(value)}</div>
        </div>
    `).join("");
}

function maybeRepairMojibake(text) {
    if (!/[Ãâð]/.test(text)) return text;
    try {
        const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        if (!decoded.includes("\uFFFD")) {
            return decoded;
        }
    } catch {
        return text;
    }
    return text;
}

function decodeLooseText(value) {
    const repaired = maybeRepairMojibake(String(value ?? ""));
    return repaired
        .replaceAll("⚠️", "WARN")
        .replaceAll("✅", "OK")
        .replaceAll("❌", "ERR")
        .replaceAll("📈", "UP")
        .replaceAll("📉", "DOWN")
        .replaceAll("🔧", "TOOL")
        .replaceAll("💰", "$")
        .replaceAll("🧠", "REFLECT")
        .replaceAll("🚀", "START")
        .replaceAll("📩", "MSG")
        .replaceAll("—", "-")
        .replaceAll("…", "...")
        .replaceAll(/^\?\?\s*/gm, "")
        .trim();
}

async function fetchJson(url) {
    const response = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.json();
}

function classifyLogMessage(message, level) {
    const text = decodeLooseText(message);
    if (level === "ERROR" || /failed|error/i.test(text)) return "error";
    if (level === "WARN" || text.includes("WARN")) return "warning";
    if (text.includes("Tool call")) return "tool-call";
    if (text.includes("Tool result")) return "tool-result";
    if (text.includes("[Trading][Cycle")) return "cycle";
    if (text.includes("Light decision") || text.includes("Ultra Light decision")) return "decision";
    if (text.includes("[NickTheCoolst]") || text.includes("NickTheCoolst") || text.includes("MSG")) return "message";
    if (/Listening on port|Bot started|Starting/i.test(text)) return "startup";
    return "info";
}

function parseLogLines(lines) {
    return (lines || []).map((line) => {
        const match = /^\[(.*?)\]\s+\[(.*?)\]\s+(.*)$/.exec(line);
        if (!match) {
            return {
                raw: line,
                timestamp: "",
                level: "INFO",
                message: decodeLooseText(line),
                kind: "info",
            };
        }

        const [, timestamp, level, rawMessage] = match;
        const message = decodeLooseText(rawMessage);
        return {
            raw: line,
            timestamp,
            level,
            message,
            kind: classifyLogMessage(message, level),
        };
    });
}

function getLatestOfKind(events, kind) {
    return [...events].reverse().find((event) => event.kind === kind) || null;
}

function renderHero(runtime, liveDataError) {
    const mode = runtime.mode.toUpperCase();
    const errorClass = liveDataError || runtime.lastError ? "warning" : "info";
    const errorText = decodeLooseText(liveDataError || runtime.lastError || "No critical errors");

    elements.heroLive.innerHTML = `
        <div>
            <div class="status-pill ${errorClass}">MODE ${escapeHtml(mode)}</div>
            <div class="mini-card" style="margin-top: 12px;">
                <strong>Last activity</strong>
                <div>${escapeHtml(formatDate(runtime.lastActivityAt))}</div>
            </div>
            <div class="mini-card ${errorClass}" style="margin-top: 12px;">
                <strong>Error status</strong>
                <div>${escapeHtml(compactText(errorText, 140))}</div>
            </div>
        </div>
    `;
}

function renderConsole(logs) {
    const parsed = parseLogLines(logs.todayLogLines || []);
    const lastCycle = getLatestOfKind(parsed, "cycle");
    const lastToolCall = getLatestOfKind(parsed, "tool-call");
    const lastToolResult = getLatestOfKind(parsed, "tool-result");
    const lastMessage = getLatestOfKind(parsed, "message");
    const lastError = getLatestOfKind(parsed, "error") || getLatestOfKind(parsed, "warning");

    elements.consoleHighlights.innerHTML = [
        miniCard("Last cycle event", lastCycle ? compactText(lastCycle.message, 120) : "n/a", "tone-cycle"),
        miniCard("Last tool call", lastToolCall ? compactText(lastToolCall.message, 120) : "n/a", "tone-tool"),
        miniCard("Last tool result", lastToolResult ? compactText(lastToolResult.message, 120) : "n/a", "tone-tool"),
        miniCard("Last Telegram message", lastMessage ? compactText(lastMessage.message, 120) : "n/a", "tone-message"),
        miniCard("Last warning/error", lastError ? compactText(lastError.message, 120) : "No recent issues", "tone-warning"),
    ].join("");

    const latestEvents = parsed.slice(-40).reverse();
    elements.consoleStream.innerHTML = latestEvents.length
        ? latestEvents.map((event) => `
            <article class="console-line tone-${escapeHtml(event.kind)}">
                <div class="console-meta">
                    <span class="console-kind">${escapeHtml(event.kind)}</span>
                    <span>${escapeHtml(formatDate(event.timestamp))}</span>
                    <span>${escapeHtml(event.level)}</span>
                </div>
                <div class="console-text">${escapeHtml(event.message)}</div>
            </article>
        `).join("")
        : `<div class="empty-state">No log lines available.</div>`;
}

function renderOverview(overview) {
    const account = overview.account;
    const runtime = overview.runtime;
    const risk = overview.dailyRiskStatus;
    const positions = overview.positions || [];
    const openOrders = overview.openOrders || [];

    renderHero(runtime, overview.liveDataError);
    elements.overviewGeneratedAt.textContent = `Updated: ${formatDate(overview.generatedAt)}`;

    elements.metricGrid.innerHTML = [
        metricCard("Equity", account ? formatCurrency(account.equity) : "n/a", `Mode: ${runtime.mode}`),
        metricCard("Cash", account ? formatCurrency(account.cash) : "n/a", `${positions.length} positions`),
        metricCard("Buying Power", account ? formatCurrency(account.buying_power) : "n/a", `${openOrders.length} open orders`),
        metricCard("Daily Risk", risk ? formatCurrency(risk.drawdownAmount) : "n/a", risk ? `${risk.breached ? "guard active" : "guard clear"} | limit ${formatCurrency(-Math.abs(risk.limitAmount))}` : "Live data missing"),
    ].join("");

    const latestTradingSummary = decodeLooseText(runtime.lastTradingSummary || overview.recentHighlights.trading?.summary || "No trading summary yet.");
    const latestLightSummary = decodeLooseText(runtime.lastLightDecisionSummary || overview.recentHighlights.light?.summary || "No light decision yet.");
    const latestUltraLightSummary = decodeLooseText(runtime.lastUltraLightDecisionSummary || overview.recentHighlights.ultraLight?.summary || "No ultra-light decision yet.");
    const latestReflection = decodeLooseText(runtime.lastReflectionSummary || overview.latestReflection?.lessons || overview.recentHighlights.reflection?.summary || "No reflection yet.");
    const latestWeeklyReview = decodeLooseText(overview.latestWeeklyReflection?.strategy_adjustments || overview.latestWeeklyReflection?.lessons || "No weekend review yet.");

    elements.activitySummary.innerHTML = [
        miniCard("Active mode", `${runtime.mode}${runtime.currentCycleId ? ` | Cycle ${runtime.currentCycleId}` : ""}`, "tone-cycle"),
        miniCard("Last light decision", compactText(latestLightSummary, 180), "tone-tool"),
        miniCard("Last ultra-light", compactText(latestUltraLightSummary, 180), "tone-tool"),
        miniCard("Last trading summary", compactText(latestTradingSummary, 180), "tone-cycle"),
        miniCard("Last reflection", compactText(latestReflection, 180), "tone-message"),
        miniCard("Next week focus", compactText(latestWeeklyReview, 180), "tone-warning"),
    ].join("");

    elements.runtimeDetails.innerHTML = keyValueRows([
        ["Current cycle", runtime.currentCycleId ?? "none"],
        ["Trading started", formatDate(runtime.lastTradingCycleStartedAt)],
        ["Trading finished", formatDate(runtime.lastTradingCycleFinishedAt)],
        ["Last light cycle", formatDate(runtime.lastLightCycleAt)],
        ["Last ultra-light", formatDate(runtime.lastUltraLightCycleAt)],
        ["Last reflection", formatDate(runtime.lastReflectionCycleAt)],
        ["Last activity", formatDate(runtime.lastActivityAt)],
        ["Light abort requested", runtime.lightCycleAbortRequested ? "true" : "false"],
        ["Timezone", runtime.schedule.timezone],
        ["Trading cadence", `every ${runtime.schedule.tradingCycleHours}h`],
        ["Reflection cadence", `every ${runtime.schedule.reflectionCycleHours}h`],
        ["Weekend review", "Sat + Sun 12:05"],
        ["Light cycle", runtime.schedule.lightCycleEnabled ? `every ${runtime.schedule.lightCycleIntervalMinutes}m` : "disabled"],
        ["Ultra-light cycle", runtime.schedule.ultraLightCycleEnabled ? `every ${runtime.schedule.ultraLightCycleIntervalMinutes}m` : "disabled"],
    ]);

    elements.positionsCount.textContent = String(positions.length);
    elements.positionsBody.innerHTML = positions.length
        ? positions.map((position) => `
            <tr>
                <td><code>${escapeHtml(position.symbol)}</code></td>
                <td>${escapeHtml(position.qty)}</td>
                <td>${escapeHtml(formatCurrency(position.avg_entry_price))}</td>
                <td>${escapeHtml(formatCurrency(position.current_price))}</td>
                <td class="${Number(position.unrealized_pl) >= 0 ? "positive" : "negative"}">${escapeHtml(formatCurrency(position.unrealized_pl))}</td>
            </tr>
        `).join("")
        : `<tr><td colspan="5" class="empty-state">No open positions.</td></tr>`;

    elements.ordersCount.textContent = String(openOrders.length);
    elements.ordersBody.innerHTML = openOrders.length
        ? openOrders.map((order) => `
            <tr>
                <td>${escapeHtml(order.side.toUpperCase())}</td>
                <td><code>${escapeHtml(order.symbol)}</code></td>
                <td>${escapeHtml(order.qty)}</td>
                <td>${escapeHtml(order.type)}</td>
                <td>${escapeHtml(order.status)}</td>
            </tr>
        `).join("")
        : `<tr><td colspan="5" class="empty-state">No open orders.</td></tr>`;

    const reflection = overview.latestReflection;
    elements.reflectionCard.innerHTML = reflection ? `
        <article>
            <strong>Created</strong>
            <div>${escapeHtml(formatDate(reflection.created_at))}</div>
        </article>
        <article>
            <strong>Total PnL</strong>
            <div class="${Number(reflection.total_pnl) >= 0 ? "positive" : "negative"}">${escapeHtml(formatCurrency(reflection.total_pnl))}</div>
        </article>
        <article>
            <strong>Lessons learned</strong>
            <div>${escapeHtml(decodeLooseText(reflection.lessons || "n/a"))}</div>
        </article>
        <article>
            <strong>Strategy adjustments</strong>
            <div>${escapeHtml(decodeLooseText(reflection.strategy_adjustments || "n/a"))}</div>
        </article>
    ` : `<div class="empty-state">No reflection in the log yet.</div>`;

    const weeklyReview = overview.latestWeeklyReflection;
    elements.weeklyReviewCard.innerHTML = weeklyReview ? `
        <article>
            <strong>Review window</strong>
            <div>${escapeHtml(formatDate(weeklyReview.period_start))} -> ${escapeHtml(formatDate(weeklyReview.period_end))}</div>
        </article>
        <article>
            <strong>Created</strong>
            <div>${escapeHtml(formatDate(weeklyReview.created_at))}</div>
        </article>
        <article>
            <strong>Lessons learned</strong>
            <div>${escapeHtml(decodeLooseText(weeklyReview.lessons || "n/a"))}</div>
        </article>
        <article>
            <strong>Strategy adjustments</strong>
            <div>${escapeHtml(decodeLooseText(weeklyReview.strategy_adjustments || "n/a"))}</div>
        </article>
    ` : `<div class="empty-state">No weekend review stored yet. It will run automatically on Saturday and Sunday.</div>`;

    const tokenUsage = overview.tokenUsage;
    elements.tokenUsage.innerHTML = keyValueRows([
        ["1h total", formatNumber((tokenUsage["1h_prompt"] || 0) + (tokenUsage["1h_comp"] || 0))],
        ["24h total", formatNumber((tokenUsage["24h_prompt"] || 0) + (tokenUsage["24h_comp"] || 0))],
        ["7d total", formatNumber((tokenUsage["7d_prompt"] || 0) + (tokenUsage["7d_comp"] || 0))],
        ["All total", formatNumber((tokenUsage["all_prompt"] || 0) + (tokenUsage["all_comp"] || 0))],
        ["24h requests", formatNumber(tokenUsage["24h_req"])],
        ["All requests", formatNumber(tokenUsage["all_req"])],
    ]);
}

function renderCycles(items) {
    elements.cycleTimeline.innerHTML = items.length
        ? items.map((item) => `
            <article class="timeline-item">
                <div class="timeline-meta">
                    <span class="timeline-type">${escapeHtml(item.cycleType)}</span>
                    <span>${escapeHtml(formatDate(item.createdAt))}</span>
                </div>
                <div class="timeline-summary">${escapeHtml(decodeLooseText(item.summary))}</div>
                <div class="timeline-detail">
                    <div class="mini-card">
                        <strong>Decision Audit</strong>
                        <pre>${escapeHtml(prettyJson(item.decisionAudit))}</pre>
                    </div>
                    <div class="mini-card">
                        <strong>Position Snapshot</strong>
                        <pre>${escapeHtml(prettyJson(item.positionsSnapshot))}</pre>
                    </div>
                    <div class="mini-card">
                        <strong>Account Snapshot</strong>
                        <pre>${escapeHtml(prettyJson(item.accountSnapshot))}</pre>
                    </div>
                </div>
            </article>
        `).join("")
        : `<div class="empty-state">No cycle data found.</div>`;
}

function renderTrades(items) {
    elements.tradesBody.innerHTML = items.length
        ? items.map((trade) => `
            <tr>
                <td>${escapeHtml(formatDate(trade.created_at))}</td>
                <td>${escapeHtml(String(trade.side).toUpperCase())}</td>
                <td><code>${escapeHtml(trade.symbol)}</code></td>
                <td>${escapeHtml(formatNumber(trade.qty))}</td>
                <td>${escapeHtml(trade.price == null ? "market" : formatCurrency(trade.price))}</td>
                <td>${escapeHtml(trade.status)}</td>
                <td>${escapeHtml(compactText(decodeLooseText(trade.reasoning || "n/a"), 120))}</td>
            </tr>
        `).join("")
        : `<tr><td colspan="7" class="empty-state">No trades found.</td></tr>`;
}

function renderLogs(payload) {
    elements.todayLogLabel.textContent = payload.todayLogPath || "Today";
    elements.cycleLogLabel.textContent = payload.cycleLogPath || "Cycle Log";
    elements.todayLog.textContent = (payload.todayLogLines || []).map(decodeLooseText).join("\n") || "No log lines for today.";
    elements.cycleLog.textContent = (payload.cycleLogLines || []).map(decodeLooseText).join("\n") || "No cycle log lines.";
    renderConsole(payload);
}

async function refreshDashboard() {
    try {
        const [overview, cycles, trades, logs] = await Promise.all([
            fetchJson("/api/dashboard/overview"),
            fetchJson(`/api/dashboard/cycles?limit=18&type=${encodeURIComponent(state.cycleFilter)}`),
            fetchJson("/api/dashboard/trades?limit=18"),
            fetchJson("/api/dashboard/logs/today?lines=140"),
        ]);

        renderOverview(overview);
        renderCycles(cycles.items || []);
        renderTrades(trades.items || []);
        renderLogs(logs);
    } catch (error) {
        elements.heroLive.innerHTML = `
            <div class="mini-card warning">
                <strong>Dashboard error</strong>
                <div>${escapeHtml(error.message || String(error))}</div>
            </div>
        `;
    }
}

function wireFilters() {
    document.querySelectorAll("[data-cycle-filter]").forEach((button) => {
        button.addEventListener("click", () => {
            state.cycleFilter = button.getAttribute("data-cycle-filter") || "all";
            document.querySelectorAll("[data-cycle-filter]").forEach((node) => node.classList.remove("active"));
            button.classList.add("active");
            refreshDashboard();
        });
    });
}

wireFilters();
refreshDashboard();
setInterval(refreshDashboard, POLL_INTERVAL_MS);
