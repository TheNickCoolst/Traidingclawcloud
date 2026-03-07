/**
 * Cloudflare Worker: TradingClaw Webhook Proxy
 * 
 * This edge script sits on Cloudflare's global network. Applications (like GitHub, TradingView) 
 * send webhooks to THIS edge URL. The script validates a secret token, then manually forwards 
 * the payload to your inherently insecure home IP where the TradingClaw Node.js agent is running.
 */

export interface Env {
    FORWARD_URL: string;
    SECRET_TOKEN: string;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
        }

        // Basic secret validation
        const url = new URL(request.url);
        const token = url.searchParams.get("token") || request.headers.get("Authorization");

        if (token !== env.SECRET_TOKEN && token !== \`Bearer \${env.SECRET_TOKEN}\`) {
			return new Response("Unauthorized", { status: 401 });
		}

		try {
			// Clone the body to forward it securely
			const payload = await request.text();
			const triggerId = url.searchParams.get("triggerId") || "edge_proxy_event";

			// Forward to the physical home lab running TradingClaw
			const targetHost = \`\${env.FORWARD_URL}/webhook/\${triggerId}\`;
			
			const response = await fetch(targetHost, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: payload
			});

			return new Response(\`Forwarded successfully: \${response.status}\`, { status: response.status });

		} catch (err: any) {
			return new Response(\`Proxy Forwarding Error: \${err.message}\`, { status: 500 });
		}
	},
};
