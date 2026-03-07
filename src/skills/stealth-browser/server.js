import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const server = new Server(
    { name: "stealth-browser", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

let browserInstance;
let pageInstance;

async function getBrowser() {
    if (!browserInstance) {
        browserInstance = await puppeteer.launch({
            // Headless true but stealth plugin fakes it to bypass basic detection
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', // <- this one doesn't works in some versions, omit if causes issues
                '--disable-gpu'
            ],
            ignoreHTTPSErrors: true,
        });
    }
    return browserInstance;
}

async function getPage() {
    const browser = await getBrowser();
    if (!pageInstance) {
        pageInstance = await browser.newPage();

        // Optional: Randomize viewport
        await pageInstance.setViewport({ width: 1366 + Math.floor(Math.random() * 100), height: 768 + Math.floor(Math.random() * 100) });
    }
    return pageInstance;
}

server.setRequestHandler("initialize", async () => {
    return {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "stealth-browser", version: "1.0.0" },
    };
});

server.setRequestHandler("tools/list", async () => {
    return {
        tools: [
            {
                name: "stealth_browse",
                description: "Navigate to a URL using a Cloudflare-bypassing stealth browser and return the page content as text.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string" },
                        wait_selector: { type: "string", description: "Optional CSS selector to wait for before extracting text" },
                        timeout: { type: "number", description: "Nav timeout in ms (default 30000)" }
                    },
                    required: ["url"],
                },
            },
            {
                name: "stealth_cleanup",
                description: "Closes the stealth browser to free up memory.",
                inputSchema: { type: "object", properties: {} }
            }
        ],
    };
});

server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "stealth_browse") {
        const url = args.url;
        const waitSelector = args.wait_selector;
        const timeout = args.timeout || 30000;

        try {
            const page = await getPage();
            await page.goto(url, { waitUntil: "networkidle2", timeout });

            if (waitSelector) {
                await page.waitForSelector(waitSelector, { timeout });
            }

            // Simple text extraction
            const textContent = await page.evaluate(() => {
                return document.body.innerText;
            });

            return {
                content: [{ type: "text", text: `Successfully loaded ${url}\n\nCONTENT:\n${textContent.substring(0, 15000)}...` }],
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Error browsing ${url}: ${error.message}` }],
                isError: true,
            };
        }
    }

    if (name === "stealth_cleanup") {
        if (browserInstance) {
            await browserInstance.close();
            browserInstance = null;
            pageInstance = null;
            return { content: [{ type: "text", text: "Browser closed." }] };
        }
        return { content: [{ type: "text", text: "Browser was not running." }] };
    }

    throw new Error(`Unknown tool: ${name}`);
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Stealth Browser MCP Server running on stdio");
}

main().catch(console.error);
