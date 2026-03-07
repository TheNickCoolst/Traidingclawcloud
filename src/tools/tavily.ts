import { registerTool } from "./index.js";
import { config } from "../config.js";

/**
 * Fallback search using DuckDuckGo HTML snippet scraping
 */
async function fallbackSearch(query: string, maxResults: number): Promise<string> {
    try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
            }
        });

        if (!response.ok) {
            return `DuckDuckGo Fallback Error: ${response.status} ${response.statusText}`;
        }

        const html = await response.text();

        // Simple regex to extract search results from DuckDuckGo HTML
        const resultRegex = /<a class="result__url" href="([^"]+)".*?>(.*?)<\/a>.*?<a class="result__snippet[^>]*>(.*?)<\/a>/gs;
        let match;
        const results = [];

        while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
            // Unescape basic HTML entities and strip inner tags
            const url = match[1].replace(/&amp;/g, '&');
            const title = match[2].replace(/<[^>]+>/g, '').trim();
            const snippet = match[3].replace(/<[^>]+>/g, '').trim();

            // Skip inner duckduckgo wrapper links if they occur
            if (url.startsWith('//duckduckgo.com')) continue;

            // Follow DDG redirect format (https://duckduckgo.com/l/?uddg=ENCODED_URL)
            let finalUrl = url;
            const uddgMatch = url.match(/uddg=([^&]+)/);
            if (uddgMatch) {
                finalUrl = decodeURIComponent(uddgMatch[1]);
            }

            results.push({ url: finalUrl, title, snippet });
        }

        if (results.length === 0) {
            return `## Fallback Search Results for "${query}"\nNo results found or rate limited.`;
        }

        let output = `## Fallback Search Results (DuckDuckGo) for "${query}"\n\n### Sources\n`;
        results.forEach((item, index) => {
            output += `${index + 1}. **${item.title}**\n   URL: ${item.url}\n   Snippet: ${item.snippet}\n\n`;
        });

        return output;
    } catch (err: any) {
        return `Failed to execute fallback search: ${err.message}`;
    }
}

/**
 * Perform a web search using the Tavily API
 */
async function searchWeb(input: Record<string, unknown>): Promise<string> {
    const query = typeof input.query === "string" ? input.query : "";
    if (!query) {
        return "Error: query parameter is required.";
    }

    const searchDepth = typeof input.search_depth === "string" ? input.search_depth : "basic";
    const includeRawContent = typeof input.include_raw_content === "boolean" ? input.include_raw_content : false;
    const maxResults = typeof input.max_results === "number" ? input.max_results : 5;

    if (!process.env.TAVILY_API_KEY) {
        console.warn("⚠️ TAVILY_API_KEY not found. Using DuckDuckGo fallback.");
        return fallbackSearch(query, maxResults);
    }

    try {
        const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                api_key: process.env.TAVILY_API_KEY,
                query: query,
                search_depth: searchDepth,
                include_images: false,
                include_answer: true,
                include_raw_content: includeRawContent,
                max_results: maxResults,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.warn(`⚠️ Tavily API Error: ${response.status} - ${errorText}. Using fallback...`);
            return fallbackSearch(query, maxResults);
        }

        const data = await response.json();

        let result = `## Tavily Search Results for "${query}"\n\n`;

        if (data.answer) {
            result += `### AI Answer\n${data.answer}\n\n`;
        }

        if (data.results && data.results.length > 0) {
            result += `### Sources\n`;
            data.results.forEach((item: any, index: number) => {
                result += `${index + 1}. **${item.title}**\n   URL: ${item.url}\n   Snippet: ${item.content}\n\n`;
                if (includeRawContent && item.raw_content) {
                    result += `   <raw_content>\n${item.raw_content.substring(0, 1000)}...\n   </raw_content>\n\n`;
                }
            });
        } else {
            result += `No specific source links found.\n`;
        }

        return result;
    } catch (error) {
        console.warn("⚠️ Tavily request failed, attempting fallback...", error);
        return fallbackSearch(query, maxResults);
    }
}

/**
 * Register the Tavily search tool
 */
export function registerTavilyTool(): void {
    registerTool(
        "search_web",
        "Perform a web search using Tavily API to get up-to-date internet information, news, or factual answers. Use this to search the web like a human would.",
        {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The search query, phrase, or question.",
                },
                search_depth: {
                    type: "string",
                    enum: ["basic", "advanced"],
                    description: "The depth of the search. 'basic' is faster, 'advanced' is more thorough but slower.",
                },
                max_results: {
                    type: "number",
                    description: "Maximum number of search results to return (default: 5).",
                },
                include_raw_content: {
                    type: "boolean",
                    description: "If true, includes the raw HTML/text content of the pages found (can be large, default: false).",
                },
            },
            required: ["query"],
        },
        searchWeb
    );
}
