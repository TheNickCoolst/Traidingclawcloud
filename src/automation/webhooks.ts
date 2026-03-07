import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { config } from "../config.js";
import { router } from "../channels/router.js";
import { manualLightCycle, manualTradingCycle } from "../trading/engine.js";

const app = express();
const WEBHOOK_PORT = config.webhookPort;

type RateLimitEntry = {
    count: number;
    resetAt: number;
};

app.disable("x-powered-by");
app.set("trust proxy", false);
app.use(express.json({
    limit: `${Math.max(4, Math.floor(config.webhookJsonLimitKb))}kb`,
    strict: true,
    type: ["application/json", "application/*+json"],
}));
app.use(express.urlencoded({
    extended: false,
    limit: `${Math.max(4, Math.floor(config.webhookFormLimitKb))}kb`,
    parameterLimit: 20,
}));
app.use((_req, res, next) => {
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    next();
});

function getClientAddress(req: Request): string {
    return req.socket.remoteAddress || req.ip || "unknown";
}

function createRateLimiter(windowMs: number, maxRequests: number, label: string) {
    const hits = new Map<string, RateLimitEntry>();
    const safeWindowMs = Math.max(1_000, Math.floor(windowMs));
    const safeMaxRequests = Math.max(1, Math.floor(maxRequests));

    return (req: Request, res: Response, next: NextFunction): void => {
        const now = Date.now();
        const client = getClientAddress(req);

        for (const [key, entry] of hits) {
            if (entry.resetAt <= now) {
                hits.delete(key);
            }
        }

        const current = hits.get(client);
        if (!current || current.resetAt <= now) {
            hits.set(client, { count: 1, resetAt: now + safeWindowMs });
            next();
            return;
        }

        current.count += 1;
        if (current.count > safeMaxRequests) {
            const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
            res.setHeader("Retry-After", String(retryAfterSeconds));
            res.status(429).json({ error: `${label} rate limit exceeded.` });
            return;
        }

        next();
    };
}

function constantTimeTokenMatch(candidate: string, expected: string): boolean {
    const left = Buffer.from(candidate);
    const right = Buffer.from(expected);
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function isValidTriggerId(triggerId: string): boolean {
    return /^[a-zA-Z0-9_-]{1,120}$/.test(triggerId);
}

function ensureWebhookSharedSecret(req: Request, res: Response, next: NextFunction): void {
    if (!config.webhookRequireSharedSecret) {
        next();
        return;
    }

    const expectedSecret = config.webhookSharedSecret?.trim();
    if (!expectedSecret) {
        res.status(503).json({ error: "Webhook secret protection is enabled but no shared secret is configured." });
        return;
    }

    const providedSecret = req.header("x-tradingclaw-webhook-secret")?.trim()
        || req.header("authorization")?.replace(/^Bearer\s+/i, "").trim()
        || "";

    if (!providedSecret || !constantTimeTokenMatch(providedSecret, expectedSecret)) {
        res.status(401).json({ error: "Webhook secret missing or invalid." });
        return;
    }

    next();
}

const webhookRateLimiter = createRateLimiter(config.webhookRateLimitWindowMs, config.webhookRateLimitMax, "Webhook");

async function relayEscalationToMain(handover: {
    source?: "light" | "ultra_light";
    reason?: string;
    context?: string;
    confidence?: number;
}): Promise<void> {
    const targetUrl = config.escalationMainUrl;
    if (!targetUrl) {
        const summary = await manualTradingCycle(handover);
        console.log(`[Webhook] Light escalation executed local main cycle. ${summary.slice(0, 220)}`);
        return;
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    const secret = config.escalationSharedSecret?.trim();
    if (secret) headers["x-tradingclaw-webhook-secret"] = secret;

    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Math.floor(config.escalationRequestTimeoutMs));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(targetUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(handover),
            signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
            console.error(`[Webhook] Escalation relay failed (${response.status}): ${text.slice(0, 200)}`);
            return;
        }
        console.log(`[Webhook] Escalation relayed to main service: ${text.slice(0, 200)}`);
    } catch (err: any) {
        console.error(`[Webhook] Escalation relay error: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }
}

app.get("/", (_req, res) => {
    res.status(410).json({ error: "Web UI disabled. Telegram is the active control surface." });
});

app.post("/webhook/:triggerId", webhookRateLimiter, ensureWebhookSharedSecret, async (req, res) => {
    const rawTriggerId = req.params.triggerId;
    const triggerId = Array.isArray(rawTriggerId) ? rawTriggerId[0] : rawTriggerId;
    if (!isValidTriggerId(triggerId)) {
        res.status(400).json({ error: "Invalid trigger ID." });
        return;
    }

    const bodyText = JSON.stringify(req.body);
    console.log(`[Webhook] Received trigger: ${triggerId}`);

    const rootAdminId = config.allowedUserIds[0] ?? 0;
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

app.post("/internal/escalate/main", webhookRateLimiter, ensureWebhookSharedSecret, async (req, res) => {
    const handover = (req.body ?? {}) as {
        source?: "light" | "ultra_light";
        reason?: string;
        context?: string;
        confidence?: number;
    };
    console.log("[Webhook] Internal escalation request accepted -> MAIN");
    res.status(202).json({ status: "accepted", target: "main" });

    void (async () => {
        try {
            const summary = await manualTradingCycle(handover);
            console.log(`[Webhook] Internal MAIN escalation completed. ${summary.slice(0, 260)}`);
        } catch (err: any) {
            console.error(`[Webhook] Internal MAIN escalation failed: ${err.message}`);
        }
    })();
});

app.post("/internal/escalate/light", webhookRateLimiter, ensureWebhookSharedSecret, async (_req, res) => {
    console.log("[Webhook] Internal escalation request accepted -> LIGHT");
    res.status(202).json({ status: "accepted", target: "light" });

    void (async () => {
        try {
            const result = await manualLightCycle();
            console.log(`[Webhook] Internal LIGHT escalation completed. ${result.summary.slice(0, 260)}`);
            if (result.triggerMain && result.handover) {
                await relayEscalationToMain(result.handover);
            }
        } catch (err: any) {
            console.error(`[Webhook] Internal LIGHT escalation failed: ${err.message}`);
        }
    })();
});

app.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[Webhook] Unhandled request error:", err);
    if (res.headersSent) {
        return;
    }
    res.status(500).json({ error: "Internal server error." });
});

let webhookServer: Server | null = null;

export function startWebhookServer() {
    if (webhookServer) {
        console.log(`[Webhook] Already listening on port ${WEBHOOK_PORT}. Skipping duplicate start.`);
        return;
    }

    webhookServer = app.listen(WEBHOOK_PORT, () => {
        console.log(`[Webhook] Listening on port ${WEBHOOK_PORT}`);
        console.log("[Webhook] Web UI disabled. Telegram notifications are active.");
    });
    webhookServer.on("error", (err: any) => {
        console.error(`[Webhook] Server error: ${err.message}`);
    });
}
