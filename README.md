# OpenClaw

Hệ thống multi-bot AI cho doanh nghiệp — mỗi bot là 1 trợ lý thông minh, quản lý qua chat, không cần code.

## Kiến trúc

```mermaid
graph TD
    U[👤 User — Telegram] --> Q[📬 Message Queue]
    Q --> CTX[📋 Build Context]
    CTX --> SDK[🤖 Claude Agent SDK]
    SDK -->|spawn| MCP[🔧 MCP Server — 54 tools]
    MCP --> DB[(🗄️ PostgreSQL)]
    MCP --> S3[📦 S3 Storage]
    SDK --> RES[📤 Response → Telegram]
    RES --> LOG[📝 Bot Logs]

    style SDK fill:#4A90D9,color:#fff
    style MCP fill:#E74C3C,color:#fff
```

**Claude Agent SDK** gọi tools native qua **MCP protocol** — không parse text, không bịa tool names.

## Tính năng

### Multi-Bot
- 1 process chạy N bots Telegram cùng lúc
- Mỗi bot = 1 tenant riêng (data, users, knowledge tách biệt)
- Super Admin quản lý tất cả bots
- Thêm bot = thêm token vào DB → chạy ngay

### 54 Tools (MCP Native)
| Nhóm | Tools |
|------|-------|
| **Data** | create_collection, add_row, list_rows, update_row, delete_row, search_all |
| **Workflow** | create_workflow, update_workflow, list_workflows, start_workflow_instance |
| **Form** | create_form, update_form, start_form, update_form_field, get_form_state |
| **File** | list_files, read_file_content, analyze_image, send_file |
| **User** | list_users, set_user_role, db_query |
| **Agent** | create_agent_template, spawn_agent, kill_agent, list_agents |
| **Bot** | create_bot, stop_bot, list_bots |
| **System** | get_dashboard, update_ai_config, save_doc, get_doc |
| **Cron** | create_cron, list_crons, delete_cron |
| **SSH** | ssh_exec, ssh_confirm |
| **Rules** | create_rule |

### Bot Knowledge (bot_docs)
- 1 document per tenant — inject thẳng vào prompt
- Bot tự lưu khi user dạy: "nhớ giùm..."
- Admin sửa trực tiếp trên Dashboard
- Không search/score — inject toàn bộ

### File Upload + Auto-Analyze
- User gửi file (PDF/DOCX/XLSX/ảnh) → upload S3
- Auto-analyze bằng LLM → tóm tắt nội dung
- Lưu vào context → user hỏi tiếp → bot có data sẵn

### Phân quyền (CRUDM)
- Admin → full quyền
- Manager → quyền mặc định + cấp quyền cho staff
- Staff/Sales → xin quyền từ manager
- Bắn đúng 1 người (reports_to)
- `/grant`, `/revoke`, `/permissions`

### User Registration
- `/register` → nhập thông tin → admin duyệt
- `/approve`, `/reject`, `/pending`

### Cron Jobs
- Tạo qua chat: "nhắc deadline mỗi sáng 8h"
- Orchestrator tick 5s → check + execute
- Log kết quả + gửi notification

### Dashboard (Web)
- Overview: bots, users, collections, files
- CRUD: forms, workflows, rules, agents
- Detail panel: click row → xem đầy đủ
- Knowledge docs: markdown editor
- Live logs: WebSocket real-time
- Port 3102

## Cài đặt

### Yêu cầu
- Node.js >= 22
- PostgreSQL >= 16
- Claude Code CLI (claude login trên server)
- S3 storage

### Quick Start

```bash
git clone https://github.com/TungND2k2/OpenClaw.git
cd OpenClaw && npm install
cp .env.example .env  # sửa config
npx tsx scripts/setup-demo.ts <TELEGRAM_ID>
npx tsx src/index.ts
```

### Production

```bash
# Server
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs postgresql mupdf-tools
npm install -g pm2 @anthropic-ai/claude-code

# PostgreSQL
sudo -u postgres createuser openclaw -P
sudo -u postgres createdb openclaw -O openclaw

# Deploy
cd /opt && git clone https://github.com/TungND2k2/OpenClaw.git
cd OpenClaw && npm install && cp .env.example .env
npx tsx scripts/setup-demo.ts <TELEGRAM_ID>

# Claude login (Max subscription)
claude auth login

# Start
pm2 start "npx tsx src/index.ts" --name openclaw
pm2 save && pm2 startup

# Dashboard
cd web && npm install && npx vite build
# → http://server:3102
```

### Update

```bash
cd /opt/OpenClaw && git pull && npm install && pm2 restart openclaw
```

## .env

```env
DATABASE_URL=postgresql://openclaw:pass@localhost:5432/openclaw
NODE_ENV=production

# Worker LLM (fast, cheap)
WORKER_API_BASE=https://api.openai.com/v1
WORKER_API_KEY=
WORKER_MODEL=gpt-4o-mini

# S3
S3_ENDPOINT=https://s3.example.com
S3_REGION=us-east-1
S3_BUCKET=your-bucket
S3_ACCESS_KEY=
S3_SECRET_KEY=

# Telegram (fallback — tokens nên lưu DB)
TELEGRAM_BOT_TOKEN=
TELEGRAM_DEFAULT_TENANT_ID=
```

## Cấu trúc

```
src/
├── bot/
│   ├── pipeline.ts          — 3 steps: context → SDK+MCP → log
│   ├── prompt-builder.ts    — system prompt from DB
│   ├── tool-registry.ts     — Map<string, handler> 54 tools
│   └── telegram.bot.ts      — multi-bot polling + file upload
├── mcp/
│   ├── server.ts            — MCP server (auto from registry)
│   └── stdio-server.ts      — entry point cho SDK subprocess
├── api/
│   └── dashboard.ts         — Express API + WebSocket + static web
├── modules/
│   ├── agents/              — templates, pool, runner (SDK+MCP)
│   ├── collections/         — dynamic tables CRUD
│   ├── context/             — token counter, compactor, file context
│   ├── cache/               — resource cache per tenant
│   ├── logs/                — bot logger (persistent DB)
│   ├── conversations/       — session state, summary
│   ├── permissions/         — CRUDM, grant flow
│   ├── workflows/           — workflow + form engine
│   ├── events/              — event bus + agent subscriptions
│   ├── cron/                — scheduled tasks
│   ├── ssh/                 — remote execution
│   └── ...
└── web/                     — React dashboard (Tailwind)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22 + TypeScript |
| Database | PostgreSQL 16 + Drizzle ORM |
| AI | Claude Agent SDK + MCP |
| Bot | Telegram Bot API (multi-bot) |
| Storage | S3-compatible |
| Dashboard | React + Tailwind + Vite |
| Process | PM2 |
