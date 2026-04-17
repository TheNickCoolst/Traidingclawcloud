TradingClaw Autonomous Agent
**Version:** 0.0.1 
(Future Versions will be coming)
Don´t Use This Version for Real Money Trading this Version, that I had builded is for Testing if it woud realy Work.

TradingClaw is a locally-hosted, fully autonomous AI agent. Across 10 distinct phases, it has been expanded from a simple Telegram chat-bot into a sophisticated, proactive memory-graph system capable of OS manipulation, browser automation, dynamic swarm logic, and physical IoT triggers.

## Architecture & Capabilities

### 1. Intelligent Routing & UI
- **Multi-Channel Native Routing (`src/channels/`)**: Unifies text, voice, and system triggers into a centralized bus.
- **Telegram UX**: Supports Voice-to-Text transcription via OpenAI Whisper, displays native UI command auto-completion, and visually pulses typing indicators during deep LLM reasoning.

### 2. Multi-LLM Agility
- Connected to OpenRouter for continuous failover capabilities and diverse model routing (e.g. `claude-opus-4.7`, `claude-sonnet-4.6`or Free Models on Openrouter(only 50 Requests a Day I think)).
- Implements specialized "Thinking Levels" preventing basic tasks from burning tokens, while allowing deep reasoning for complex queries.

### 3. Memory & Subconscious
- **SQLite FTS5 Knowledge Graph (`src/memory/`)**: Binds raw session dialog, relational concepts, and multimodal imagery descriptions securely into local long-term storage.
- **Auto-Pruning Context**: Prevents context-window overflow by dynamically summarising dead conversations.

### 4. Native OS & Web Tools
- **Shell & FS (`src/tools/shell.ts`, `fs.ts`)**: The LLM can execute native Bash commands, read directories, and author files.
- **Puppeteer Headless Browsing (`src/tools/browser.ts`)**: Invisible Chrome manipulation for scraping raw JavaScript-rendered doms.
- **MCP Extensibility (`src/mcp.ts`)**: Bridges Model Context Protocol servers mapping standard tool configurations dynamically.

### 5. Proactive Autonomy & IoT
- **Heartbeat & Cron Syndication (`src/automation/`)**: Independently wakes the agent every N minutes to introspect memory queues, perform Morning/Evening news briefings via Web Search, and reach out via Telegram unprompted.
- **Hardware Webhooks (`hardware/esp32_bridge/`)**: External Node server endpoints allow ESP32 microcontrollers and Github Actions to execute Agent thought-loops directly.
- **Trailing Inference**: Always appends actionable, contextual button recommendations to user replies.

### 6. Swarm Engine & Workflows(Does not work in this version)
- **Sub-agents (`src/architecture/swarm.ts`)**: Primary loop can recursively spawn isolated agent-threads for heavy research tasks.
- **Mesh Workflows (`src/architecture/workflows.ts`)**: Predefined execution pipelines enforcing strict outputs for daily analyses.
- **Plugins (`src/architecture/plugins.ts`)**: Emitter hooks allow drop-in Javascript logic to mutate AI context pre/post execution.

## Deployment & Setup

### Environment Variables (.env)
You must create a `.env` in the root mapping:
\`\`\`env
TELEGRAM_BOT_TOKEN="your_token"
OPENROUTER_API_KEY="sk-or-v1-..."
ALLOWED_USER_IDS="1234567,987654"
OPENAI_API_KEY="sk-..."  # Used purely for Whisper Voice
ELEVENLABS_API_KEY="..."

# Proactive Behaviours
HEARTBEAT_ENABLED=true
HEARTBEAT_INTERVAL_MINUTES=60
\`\`\`

### Running Locally
\`\`\`bash
npm install
npm run dev
\`\`\`

Webhook + Telegram automation:
- `npm run dev` and `npm start` expose the webhook listener on `http://127.0.0.1:3000/webhook/:triggerId`
- The web UI is disabled; Telegram is the active reporting surface
- Weekend review runs automatically on Saturday and Sunday at 12:05 Berlin time
- Production security envs support webhook shared-secret enforcement, route rate limits, strict body limits, and verbose Telegram trading notifications

### Docker & Edge Proxies
TradingClaw ships with a native Alpine Node.js `Dockerfile` binding Chromium binaries directly for headless scraping.
\`\`\`bash
docker-compose up -d
\`\`\`

If exposing the webhook listener (`Port 3000`) for Github or IoT, it is recommended to deploy the included `/workers/proxy/` Cloudflare Edge script to obfuscate your home residential IP.

