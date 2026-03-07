import { registerTool } from "./index.js";
import puppeteer from "puppeteer-core";
import os from "os";

// Heuristic to locate Chromium locally natively so we don't have to download thousands of megabytes into node_modules
function findChromeExecutable(): string {
    const platform = os.platform();
    if (platform === "win32") {
        return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    } else if (platform === "darwin") {
        return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    } else {
        return "/usr/bin/google-chrome"; // Linux fallback
    }
}

registerTool(
    "browser_navigate",
    "Navigate to a specific URL in a headless browser and extract pure reading text.",
    {
        type: "object",
        properties: {
            url: { type: "string", description: "Absolute HTTP URL to navigate to." }
        },
        required: ["url"],
    },
    async (input) => {
        const targetUrl = input.url as string;
        let browser;
        try {
            console.log(`🌐 [puppeteer] Navigating to: ${targetUrl}`);
            const executablePath = findChromeExecutable();

            browser = await puppeteer.launch({
                executablePath,
                headless: true,
                args: ["--no-sandbox", "--disable-setuid-sandbox"]
            });

            const page = await browser.newPage();
            // Block heavy resources
            await page.setRequestInterception(true);
            page.on("request", (req) => {
                if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

            // Extract visible string text cleanly
            const text = await page.evaluate(() => {
                // simple extraction removing scripts/styles
                const scripts = document.querySelectorAll('script, style');
                scripts.forEach(s => s.remove());
                return document.body.innerText.replace(/\n\s*\n/g, '\n').substring(0, 8000); // hard cap
            });

            return text || "Page appears to be empty or rendering failed.";

        } catch (err: any) {
            console.error("🌐 Browser Error:", err);
            return `Failed to navigate: ${err.message}. If Chrome is missing, run execute_shell with a curl or wget instead.`;
        } finally {
            if (browser) await browser.close();
        }
    }
);
