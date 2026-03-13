import { registerTool } from "./index.js";

const SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 5;
const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};
const DUCKDUCKGO_ENDPOINTS = [
    "https://html.duckduckgo.com/html/",
    "https://duckduckgo.com/html/",
];

type SearchResult = {
    title: string;
    link: string;
    snippet: string;
};

function stripHtmlTags(value: string): string {
    return value
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

function decodeDuckDuckGoLink(rawHref: string): string {
    const href = rawHref.replace(/&amp;/g, "&");
    const uddgMatch = href.match(/[?&]uddg=([^&]+)/i);
    if (uddgMatch?.[1]) {
        try {
            return decodeURIComponent(uddgMatch[1]);
        } catch {
            return uddgMatch[1];
        }
    }

    if (href.startsWith("//")) {
        return `https:${href}`;
    }

    return href;
}

function formatResults(label: string, query: string, results: SearchResult[]): string {
    const header = `Search results (${label}) for "${query}"`;
    const body = results.map((result) => {
        return `[${result.title}]\nURL: ${result.link}\nSnippet: ${result.snippet}`;
    });
    return [header, ...body].join("\n---\n");
}

function extractDuckDuckGoResults(html: string, limit: number): SearchResult[] {
    const results: SearchResult[] = [];
    const resultRegex = /<div class="result(?:__body)?".*?<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>.*?(?:<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>(.*?)<\/div>)/gis;

    for (const match of html.matchAll(resultRegex)) {
        const rawHref = match[1];
        const rawTitle = match[2];
        const rawSnippet = match[3] || match[4] || "";

        const title = stripHtmlTags(rawTitle);
        const snippet = stripHtmlTags(rawSnippet);
        const link = decodeDuckDuckGoLink(rawHref);

        if (!title || !link) {
            continue;
        }

        results.push({ title, link, snippet });
        if (results.length >= limit) {
            break;
        }
    }

    return results;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = SEARCH_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

async function searchViaTavily(query: string, limit: number): Promise<string | null> {
    if (!process.env.TAVILY_API_KEY) {
        return null;
    }

    try {
        const response = await fetchWithTimeout("https://api.tavily.com/search", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                api_key: process.env.TAVILY_API_KEY,
                query,
                search_depth: "basic",
                include_images: false,
                include_answer: true,
                include_raw_content: false,
                max_results: limit,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.warn(`[web_search] Tavily returned HTTP ${response.status}: ${errorText.slice(0, 200)}`);
            return null;
        }

        const data = await response.json();
        const results = Array.isArray(data.results)
            ? data.results
                .map((item: any) => ({
                    title: typeof item?.title === "string" ? item.title.trim() : "",
                    link: typeof item?.url === "string" ? item.url.trim() : "",
                    snippet: typeof item?.content === "string" ? item.content.trim() : "",
                }))
                .filter((item: SearchResult) => item.title && item.link)
                .slice(0, limit)
            : [];

        const sections: string[] = [];
        if (typeof data.answer === "string" && data.answer.trim()) {
            sections.push(`Answer: ${data.answer.trim()}`);
        }
        if (results.length > 0) {
            sections.push(formatResults("Tavily", query, results));
        }

        return sections.length > 0 ? sections.join("\n\n") : null;
    } catch (err: any) {
        console.warn(`[web_search] Tavily request failed: ${err?.message || String(err)}`);
        return null;
    }
}

async function searchViaDuckDuckGo(query: string, limit: number): Promise<string | null> {
    for (const endpoint of DUCKDUCKGO_ENDPOINTS) {
        const url = `${endpoint}?q=${encodeURIComponent(query)}`;

        try {
            const response = await fetchWithTimeout(url, {
                headers: DEFAULT_HEADERS,
            });

            if (!response.ok) {
                console.warn(`[web_search] DuckDuckGo returned HTTP ${response.status} from ${endpoint}`);
                continue;
            }

            const html = await response.text();
            const results = extractDuckDuckGoResults(html, limit);

            if (results.length > 0) {
                return formatResults("DuckDuckGo", query, results);
            }

            console.warn(`[web_search] DuckDuckGo returned no parsable results for "${query}" via ${endpoint}`);
        } catch (err: any) {
            console.warn(`[web_search] DuckDuckGo request failed via ${endpoint}: ${err?.message || String(err)}`);
        }
    }

    return null;
}

registerTool(
    "web_search",
    "Search the web for up-to-date facts, news, and current events. Provides titles, snippets and URLs.",
    {
        type: "object",
        properties: {
            query: { type: "string", description: "Search term or question." },
            limit: { type: "number", description: "Max results to return (default: 5)" },
        },
        required: ["query"],
    },
    async (input) => {
        const query = typeof input.query === "string" ? input.query.trim() : "";
        const limit =
            typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
                ? Math.floor(input.limit)
                : DEFAULT_LIMIT;

        if (!query) {
            return "Web search requires a non-empty query.";
        }

        console.log(`[web_search] Searching for "${query}"`);

        const tavilyResult = await searchViaTavily(query, limit);
        if (tavilyResult) {
            return tavilyResult;
        }

        const ddgResult = await searchViaDuckDuckGo(query, limit);
        if (ddgResult) {
            return ddgResult;
        }

        return `Web search is temporarily unavailable for "${query}" due to upstream network/provider issues. Continue the trading decision without assuming fresh news from this tool.`;
    }
);
