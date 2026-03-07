import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import fs from "fs";
import path from "path";
import { router } from "../channels/router.js";
import { getDashboardCycles, getDashboardLogs, getDashboardOverview, getDashboardTrades, type DashboardCycleType } from "../dashboard/service.js";

const app = express();
app.use(express.json());

const WEBHOOK_PORT = Number(process.env["WEBHOOK_PORT"] || "3000");
const UI_DIR = path.join(process.cwd(), "ui");

function isLoopbackAddress(address: string | undefined): boolean {
    if (!address) return false;
    const normalized = address.trim();
    return normalized === "::1"
        || normalized === "127.0.0.1"
        || normalized === "::ffff:127.0.0.1"
        || normalized.endsWith("127.0.0.1");
}

function ensureLocalDashboardRequest(req: Request, res: Response, next: NextFunction): void {
    const remoteAddress = req.socket.remoteAddress || req.ip;
    if (!isLoopbackAddress(remoteAddress)) {
        res.status(403).json({ error: "Dashboard is only available from localhost." });
        return;
    }
    next();
}

function sendUiFile(fileName: string, res: Response): void {
    const filePath = path.join(UI_DIR, fileName);
    if (!fs.existsSync(filePath)) {
        res.status(404).send("UI asset not found.");
        return;
    }
    res.sendFile(filePath);
}

function parseCycleType(raw: unknown): DashboardCycleType {
    const value = String(raw ?? "all").toLowerCase();
    if (value === "trading" || value === "light" || value === "reflection") {
        return value;
    }
    return "all";
}

app.get("/", ensureLocalDashboardRequest, (_req, res) => {
    sendUiFile("index.html", res);
});

app.get("/app.js", ensureLocalDashboardRequest, (_req, res) => {
    res.type("application/javascript");
    sendUiFile("app.js", res);
});

app.get("/styles.css", ensureLocalDashboardRequest, (_req, res) => {
    res.type("text/css");
    sendUiFile("styles.css", res);
});

app.get("/favicon.ico", ensureLocalDashboardRequest, (_req, res) => {
    res.status(204).end();
});

app.get("/api/dashboard/overview", ensureLocalDashboardRequest, async (_req, res) => {
    try {
        res.json(await getDashboardOverview());
    } catch (err: any) {
        console.error("[Dashboard] Overview failed:", err);
        res.status(500).json({ error: err.message || "Failed to load dashboard overview." });
    }
});

app.get("/api/dashboard/cycles", ensureLocalDashboardRequest, (req, res) => {
    try {
        const limit = Number(req.query["limit"] ?? "20");
        const type = parseCycleType(req.query["type"]);
        res.json({ items: getDashboardCycles(limit, type) });
    } catch (err: any) {
        console.error("[Dashboard] Cycles failed:", err);
        res.status(500).json({ error: err.message || "Failed to load cycles." });
    }
});

app.get("/api/dashboard/trades", ensureLocalDashboardRequest, (req, res) => {
    try {
        const limit = Number(req.query["limit"] ?? "20");
        res.json({ items: getDashboardTrades(limit) });
    } catch (err: any) {
        console.error("[Dashboard] Trades failed:", err);
        res.status(500).json({ error: err.message || "Failed to load trades." });
    }
});

app.get("/api/dashboard/logs/today", ensureLocalDashboardRequest, (req, res) => {
    try {
        const lines = Number(req.query["lines"] ?? "120");
        res.json(getDashboardLogs(lines));
    } catch (err: any) {
        console.error("[Dashboard] Logs failed:", err);
        res.status(500).json({ error: err.message || "Failed to load logs." });
    }
});

// Setup a simple catch-all trigger mapped to a specific internal channel
app.post("/webhook/:triggerId", async (req, res) => {
    const triggerId = req.params.triggerId;
    const bodyText = JSON.stringify(req.body);

    console.log(`[Webhook] Received trigger: ${triggerId}`);

    const rootAdminId = Number(process.env.ALLOWED_USER_IDS?.split(",")[0] || "0");
    const prompt = `[AUTOMATED WEBHOOK TRIGGER: ${triggerId}]\nThe following payload was received. Act accordingly based on your instructions:\n${bodyText}`;

    try {
        await router.dispatch("telegram", {
            chatId: rootAdminId,
            text: prompt,
            userId: rootAdminId,
            metadata: { automaticTask: true }
        });

        res.status(200).json({ status: "dispatched", triggerId });
    } catch (err: any) {
        console.error("[Webhook] Dispatch failed:", err);
        res.status(500).json({ error: "Agent dispatch failed" });
    }
});

export function startWebhookServer() {
    if (webhookServer) {
        console.log(`[Webhook] Already listening on port ${WEBHOOK_PORT}. Skipping duplicate start.`);
        return;
    }

    webhookServer = app.listen(WEBHOOK_PORT, () => {
        console.log(`[Webhook] Listening on port ${WEBHOOK_PORT}`);
        console.log(`[Dashboard] Local UI: http://127.0.0.1:${WEBHOOK_PORT}/`);
    });
    webhookServer.on("error", (err: any) => {
        console.error(`[Webhook] Server error: ${err.message}`);
    });
}

let webhookServer: Server | null = null;
