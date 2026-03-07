import { getSession, saveSession } from "../db.js";

export type ThinkingLevel = "off" | "low" | "medium" | "high";

/**
 * Retrieve the active thinking level preference for a session
 */
export function getThinkingLevel(sessionId: string): ThinkingLevel {
    const session = getSession(sessionId);
    if (!session || !session.summary) {
        return "off";
    }

    try {
        const metadata = JSON.parse(session.summary);
        return metadata.thinkingLevel || "off";
    } catch {
        return "off";
    }
}

/**
 * Set the thinking preference metadata onto an existing session
 */
export function setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const session = getSession(sessionId);
    if (!session) {
        // Can't set thinking level on a non-existent session
        return;
    }

    let metadata: any = {};
    if (session.summary) {
        try {
            metadata = JSON.parse(session.summary);
        } catch {
            metadata = {};
        }
    }

    metadata.thinkingLevel = level;
    saveSession(sessionId, session.channel, session.messages_json, JSON.stringify(metadata));
}
