import { registerTool } from "./index.js";

registerTool(
    "get_current_time",
    "Get the current date and time. Optionally specify an IANA timezone (e.g. 'Europe/Berlin', 'America/New_York').",
    {
        type: "object",
        properties: {
            timezone: {
                type: "string",
                description:
                    "IANA timezone identifier (e.g. 'Europe/Berlin'). Defaults to the system timezone if omitted.",
            },
        },
        required: [],
    },
    async (input) => {
        const tz = (input.timezone as string) || undefined;
        const now = new Date();

        try {
            const formatted = now.toLocaleString("en-US", {
                timeZone: tz,
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                timeZoneName: "long",
            });
            return formatted;
        } catch {
            return `Invalid timezone "${tz}". Use IANA format like "Europe/Berlin".`;
        }
    }
);
