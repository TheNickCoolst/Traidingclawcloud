import { registerTool } from "./index.js";
import { search } from "duckduckgo-images-api"; // This library works well for text/news despite its legacy name 
// DuckDuckGo API returns multiple structures. For simplicity we map standard text responses.

registerTool(
    "web_search",
    "Search the web for up-to-date facts, news, and current events. Provides titles, snippets and URLs.",
    {
        type: "object",
        properties: {
            query: { type: "string", description: "Search term or question." },
            limit: { type: "number", description: "Max results to return (default: 5)" }
        },
        required: ["query"],
    },
    async (input) => {
        const query = input.query as string;
        const limit = (input.limit as number) || 5;

        try {
            console.log(`🔍 [duckduckgo] Searching: "${query}"`);

            // DuckDuckGo library might wrap async HTTP fetching
            const options = {
                query,
                iterations: 1, // Number of pagination requests
            };

            // Using modern fetch to the HTML lite endpoint is another resilient pattern without heavy dependency overhead if DDG api fails
            const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            const res = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                }
            });

            if (!res.ok) {
                return `Web search failed (HTTP ${res.status}). Cannot fetch duckduckgo HTML.`;
            }

            const html = await res.text();

            // Extremely lightweight snippet extraction without pulling Cheerio (DOM Parser)
            // Note: In real prod, regexing HTML is brittle. But for an AI extracting context, it's remarkably fast.
            const results: string[] = [];
            const resultMatches = [...html.matchAll(/<a class="result__url" href="([^"]+)".*?>(.*?)<\/a>.*?<a class="result__snippet[^>]*>(.*?)<\/a>/gs)];

            for (let i = 0; i < Math.min(limit, resultMatches.length); i++) {
                const m = resultMatches[i];
                // Clean bold tags
                const title = m[2].replace(/<\/?[^>]+(>|$)/g, "").trim();
                const snippet = m[3].replace(/<\/?[^>]+(>|$)/g, "").trim();
                const link = m[1].includes('//duckduckgo.com/l/?') ? decodeURIComponent(m[1].split('uddg=')[1].split('&')[0]) : m[1];

                results.push(`[${title}]\nURL: ${link}\nSnippet: ${snippet}\n`);
            }

            if (results.length === 0) return "Web search returned no results.";
            return results.join("\n---\n");

        } catch (err: any) {
            console.error("🔍 Search Error:", err);
            return `Failed to execute search: ${err.message}`;
        }
    }
);
