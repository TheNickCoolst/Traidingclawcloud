TradingClaw Autonomous Agent
**Version:** 1.0.0 (Phase 10 Complete)

TradingClaw is a locally-hosted, fully autonomous AI agent. Across 10 distinct phases, it has been expanded from a simple Telegram chat-bot into a sophisticated, proactive memory-graph system capable of OS manipulation, browser automation, dynamic swarm logic, and physical IoT triggers.

## Architecture & Capabilities

### 1. Intelligent Routing & UI
- **Multi-Channel Native Routing (`src/channels/`)**: Unifies text, voice, and system triggers into a centralized bus.
- **Telegram UX**: Supports Voice-to-Text transcription via OpenAI Whisper, displays native UI command auto-completion, and visually pulses typing indicators during deep LLM reasoning.

### 2. Multi-LLM Agility
- Connected to OpenRouter for continuous failover capabilities and diverse model routing (e.g. `claude-3-opus`, `gemini-1.5-pro`).
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

### 6. Swarm Engine & Workflows
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

Local dashboard:
- `npm run dev` and `npm start` also expose a read-only observer UI at `http://127.0.0.1:3000/`
- Dashboard routes are localhost-only
- Webhooks remain available under `/webhook/:triggerId`
- Weekend review runs automatically on Saturday and Sunday at 12:05 Berlin time

### Docker & Edge Proxies
TradingClaw ships with a native Alpine Node.js `Dockerfile` binding Chromium binaries directly for headless scraping.
\`\`\`bash
docker-compose up -d
\`\`\`

If exposing the webhook listener (`Port 3000`) for Github or IoT, it is recommended to deploy the included `/workers/proxy/` Cloudflare Edge script to obfuscate your home residential IP.

---
*Built incrementally over 10 distinct phases via automated task generation.*
