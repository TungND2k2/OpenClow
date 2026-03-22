# OpenClaw

**Multi-Agent Orchestration System — Semi-Autonomous AI Workforce**

Hệ thống AI agent phân cấp, tự học, quản lý qua chat — không cần code.

---

## OpenClaw là gì?

Thay vì 1 chatbot → OpenClaw là **đội ngũ AI** làm việc như công ty thật.

Admin/Manager dạy AI qua chat → AI tự học → tự xử lý lần sau.

```mermaid
graph TD
    U[👤 User — Telegram] -->|nhắn tin| Q[📬 Message Queue]
    Q -->|priority sort| P[🔐 Permission Check]
    P -->|allowed| C[🧠 Commander]
    P -->|denied| AR[📩 Approval Request]
    AR -->|gửi 1 người| MGR[👔 Manager/Admin]
    MGR -->|/grant| P

    C -->|phân rã task| S1[📋 Supervisor 1]
    C -->|phân rã task| S2[📋 Supervisor 2]

    S1 -->|giao việc| W1[⚙️ Worker 1]
    S1 -->|giao việc| W2[⚙️ Worker 2]
    S2 -->|giao việc| W3[⚙️ Worker 3]

    W1 & W2 & W3 -->|gọi tools| T[🔧 Tool Registry]

    T --> DB[(🗄️ PostgreSQL)]
    T --> S3[📦 S3 Storage]
    T --> KB[📚 Knowledge Base]
    T --> AL[📝 Audit Log]

    KB -.->|kiến thức đã học| C

    style C fill:#4A90D9,color:#fff
    style P fill:#E74C3C,color:#fff
    style S1 fill:#7B68EE,color:#fff
    style S2 fill:#7B68EE,color:#fff
    style W1 fill:#2ECC71,color:#fff
    style W2 fill:#2ECC71,color:#fff
    style W3 fill:#2ECC71,color:#fff
    style AL fill:#F39C12,color:#fff
```

---

## Tính năng chính

### 1. Agent phân cấp — tạo qua chat, không code

```
Admin: "tạo agent Sales Analyst chuyên phân tích file"
→ AI tạo template trong DB
→ "spawn 3 con" → 3 workers sẵn sàng
→ Tắt: "kill agent Worker-2"
```

### 2. Tự học từ hội thoại (Self-Learning)

```
Lần 1: Manager dạy "task loại A thuộc phòng X, task loại B thuộc phòng Y"
→ Lưu vào Knowledge Base + Business Rules

Lần 2: User tạo task loại A
→ AI tự phân loại → Phòng X → phân quyền xem
→ Không cần ai dạy lại
```

### 3. Dynamic Data — tạo bảng qua chat

```
Admin: "tạo bảng Đơn hàng gồm mã đơn, sản phẩm, số lượng, deadline"
→ AI tạo collection trong DB
→ "thêm đơn DH-001 sản phẩm A, 100 cái, deadline tuần sau"
→ Lưu vào PostgreSQL thật, không bịa
```

### 4. File & Vision

```
User gửi file PDF/DOCX/Excel → upload S3 → extract text
User gửi ảnh → AI phân tích nội dung (vision)
User: "đọc tài liệu hướng dẫn" → AI tự tìm file → đọc → tóm tắt
```

### 5. Phân quyền Dynamic + Approval Flow

```
Admin → full quyền, cấp/thu hồi quyền cho mọi người
Manager → quyền mặc định CRU, xin thêm từ Admin
Staff/Sales → quyền mặc định CR, xin thêm từ Manager trực tiếp

Khi không đủ quyền:
  → Hệ thống hỏi "Gửi yêu cầu xin quyền cho [Manager X]?"
  → Bắn đúng 1 người (reports_to) — không loạn
  → Manager: /grant user resource CRUD → cấp vĩnh viễn

Chưa đăng ký → /register → admin duyệt
```

### 6. Multi-step Form Persistent

```
Form 19 bước → user nhập từng field → data lưu DB mỗi bước
→ Tắt app, quay lại → data vẫn còn
→ Hỏi "bước 1 nhập gì?" → trả lời chính xác
→ Conversation auto-summary khi history dài
```

---

## Kiến trúc

```mermaid
graph LR
    subgraph Input
        TG[📱 Telegram Bot]
        MCP[🔌 MCP Server<br/>66 tools]
    end

    subgraph Core
        Q[📬 Queue<br/>5 concurrent]
        P[⚡ Pipeline<br/>Knowledge → Think → Tools → Learn]
        O[🔄 Orchestrator<br/>5s tick]
    end

    subgraph Data
        DB[(🗄️ PostgreSQL<br/>24 tables)]
        S3[📦 S3 Storage]
        KB[📚 Knowledge<br/>Self-Learning]
    end

    subgraph LLM Pool
        L1[🧠 Strong LLM<br/>Commander brain]
        L2[⚡ Fast LLM<br/>Worker brain]
    end

    TG --> Q --> P
    MCP --> P
    P --> DB & S3 & KB
    P --> L1 & L2
    O --> P
    KB -.->|đã học| P

    style L1 fill:#4A90D9,color:#fff
    style L2 fill:#2ECC71,color:#fff
    style KB fill:#F39C12,color:#fff
```

> **LLM = não, Agent = nhân viên.** Cùng não, khác job description (system prompt + tools + quyền hạn).

---

## Cấu trúc thư mục

```
src/
  ├── bot/                  Telegram bot + message queue + agent bridge
  ├── db/                   PostgreSQL schemas (Drizzle ORM)
  ├── mcp/                  MCP server + 66 tools
  ├── proxy/                LLM proxy routing
  └── modules/
       ├── agents/          Agent templates, pool, runner
       ├── collections/     Dynamic tables (CRUD)
       ├── knowledge/       Self-learning knowledge base
       ├── tasks/           Task lifecycle
       ├── orchestration/   Task decomposition, DAG, auto-assign
       ├── workflows/       Workflow + form + rules engine
       ├── storage/         S3 + PDF/DOCX/XLSX extraction
       ├── permissions/      Dynamic RBAC + approval flow + audit
       ├── conversations/   Session state + form state + summary
       ├── decisions/       Decision audit trail
       ├── monitoring/      Health check, budget
       └── ...
```

---

## Bot Commands

| Command | Role | Mô tả |
|---------|------|--------|
| `/start` | all | Xem hướng dẫn |
| `/register` | guest | Đăng ký sử dụng |
| `/approve <id>` | admin | Duyệt đăng ký |
| `/reject <id>` | admin | Từ chối đăng ký |
| `/pending` | admin | Xem đăng ký chờ duyệt |
| `/grant <user> <resource> <access>` | admin/manager (cần M) | Cấp quyền (CRUDM/CRUD/CRU/CR/R) |
| `/deny <requestId>` | admin/manager | Từ chối yêu cầu quyền |
| `/revoke <user> <resource>` | admin/manager | Thu hồi quyền |
| `/permissions` | admin/manager | Xem yêu cầu quyền đang chờ |

---

## Testing Guide

### 1. Form State — multi-step form

```
User: "nhập đơn hàng"
→ Bot gọi start_form → hỏi field đầu tiên
→ Nhập 3-4 field liên tiếp
→ Hỏi "bước 1 tôi nhập gì?" → bot trả lời đúng từ DB
→ "sửa bước 2 thành ABC" → bot update DB
→ Tắt app, quay lại "tiếp tục nhập đơn" → resume đúng chỗ
```

### 2. Permission — quyền mặc định

```
Manager nhắn: "tạo form mới tên Test" → OK (có quyền C trên form_templates)
Sales nhắn: "xoá form Test" → Từ chối (sales không có D trên form_templates)
Admin nhắn: bất kỳ → OK (full quyền)
```

### 3. Approval Flow — xin quyền

```
Sales nhắn: "tạo workflow mới"
→ Bot: "Bạn chưa có quyền. Gửi yêu cầu cho [Manager]?"
→ Sales: "ok"
→ Manager nhận: "🔔 [Sales] xin quyền CRU trên workflow_templates"
→ Manager: /grant <sales_id> workflow_templates CRU
→ Sales nhận: "🔓 Bạn đã được cấp quyền CRU trên workflow_templates"
→ Sales tự tạo workflow từ giờ — không cần hỏi lại
```

### 4. Grant/Revoke commands

```
/grant kristina knowledge_entries CRUD     → cấp quyền
/revoke kristina knowledge_entries          → thu hồi
/permissions                                → xem yêu cầu đang chờ
```

### 5. Conversation Summary

```
Chat > 15 messages → hệ thống tự tóm tắt
→ Prompt nhẹ hơn, token ít hơn
→ Bot vẫn nhớ context quan trọng
```

---

## Triển khai

### Yêu cầu

- **Node.js** >= 22
- **PostgreSQL** >= 16
- **LLM CLI** (cho Commander brain — optional)
- **S3 storage** (cho file upload)

### Quick Start

```bash
# 1. Clone
git clone https://github.com/TungND2k2/OpenClow.git
cd OpenClow && npm install

# 2. Config
cp .env.example .env
# Sửa .env: DATABASE_URL, TELEGRAM_BOT_TOKEN, S3 keys

# 3. Setup
npx tsx scripts/setup-demo.ts <YOUR_TELEGRAM_ID>
# Copy TELEGRAM_DEFAULT_TENANT_ID vào .env

# 4. Run
npx tsx src/index.ts
```

### Production (Ubuntu)

```bash
# Cài dependencies
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs postgresql
npm install -g pm2 @anthropic-ai/claude-code

# PostgreSQL setup
sudo -u postgres createuser openclaw -P    # password: openclaw123
sudo -u postgres createdb openclaw -O openclaw

# Clone + deploy
cd /opt && git clone https://github.com/TungND2k2/OpenClow.git
cd OpenClow && npm install
cp .env.example .env && nano .env

# Setup + start
npx tsx scripts/setup-demo.ts <TELEGRAM_ID>
pm2 start "npx tsx src/index.ts" --name openclaw
pm2 save && pm2 startup

# LLM CLI login (cho Commander brain)
# Cấu hình theo provider bạn dùng
```

### Update

```bash
cd /opt/OpenClow && git pull && npm install && pm2 restart openclaw
```

---

## .env

```env
# Database (PostgreSQL)
DATABASE_URL=postgresql://openclaw:openclaw123@localhost:5432/openclaw

# Server
NODE_ENV=production

# Telegram
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_DEFAULT_TENANT_ID=   # từ setup-demo

# S3 Storage
S3_ENDPOINT=https://s3.example.com
S3_REGION=us-east-1
S3_BUCKET=your-bucket
S3_ACCESS_KEY=
S3_SECRET_KEY=

# LLM (optional — Workers dùng fast API)
WORKER_API_BASE=https://api.openai.com/v1
WORKER_API_KEY=
WORKER_MODEL=gpt-4o-mini
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22 + TypeScript |
| Database | PostgreSQL 16 + Drizzle ORM |
| MCP | @modelcontextprotocol/sdk |
| AI | LLM API (OpenAI-compatible) |
| Bot | Telegram Bot API (long-polling) |
| Storage | S3-compatible |
| Process | PM2 |

---

## Docs

| Doc | Nội dung |
|-----|----------|
| [FORM-STATE.md](docs/FORM-STATE.md) | Multi-step form persistent — summary + form state |
| [ROADMAP-LEARNED-ROUTING.md](docs/ROADMAP-LEARNED-ROUTING.md) | Tự học engine routing CLI/fast-api (PENDING) |

---

## Changelog

### v0.5.0 — Dynamic Permissions + Audit Trail
- **`db_query` meta-tool**: 1 tool generic thay 20+ tools riêng — AI tự CRUD bất kỳ resource
- **Permission check**: mọi thao tác qua `db_query` đều check quyền theo role
- **Grant flow**: `/grant user resource CRUD` — cấp quyền vĩnh viễn, `/revoke` thu hồi
- **Approval request**: user không đủ quyền → hệ thống gửi yêu cầu cho `reports_to` (1 người)
- **Owner tracking**: `created_by_user_id`, `created_by_name`, `updated_by_*` trên mọi record
- **Audit trail**: mọi thao tác CRUD lưu log (ai, làm gì, khi nào)
- **Commands mới**: `/grant`, `/deny`, `/revoke`, `/permissions`

### v0.4.0 — Form State + Conversation Summary
- **Conversation Summary**: auto tóm tắt mỗi 10 messages → giữ summary + 5 recent → tiết kiệm tokens
- **Form State**: multi-step form lưu per-user session trong DB → không mất data khi history dài
- **Tools mới**: `start_form`, `update_form_field`, `get_form_state`, `cancel_form`
- **Auto-save**: form complete → `add_row` vào collection (TODO)

### v0.3.0 — PostgreSQL + Smart Search
- Chuyển SQLite → **PostgreSQL** (data persistent, remote access)
- **Smart search**: `search_all(keyword)` filter DB trước khi gửi LLM
- **Pagination**: > 20 rows → trả summary + hint xem tiếp
- **Knowledge dedup**: merge rules cùng intent, tăng `usage_count`

### v0.2.0 — Agent System + Self-Learning
- **Agent Templates**: tạo agent qua chat, không code
- **AgentPool**: Commander + Workers spawn từ templates
- **Self-learning**: 34 rules tự học từ hội thoại (intent-based merge)
- **Business Rules**: phân loại task theo bộ phận (Sản xuất, Marketing, Sales, Kế toán)
- **Dynamic Collections**: admin tạo bảng qua chat, CRUD data thật trong DB
- **Image Vision**: phân tích ảnh qua LLM CLI + Read tool
- **File parsing**: PDF (mutool fallback), DOCX (mammoth), XLSX
- **S3 Storage**: upload files từ Telegram → S3

### v0.1.0 — Foundation
- Telegram bot + message queue (5 concurrent)
- MCP server (66 tools)
- Orchestrator (health check, task dispatch, DAG rollup)
- Role-based access (admin → manager → sales/staff/user)
- User registration (`/register` → admin approve)
- Progress messages (edit cùng 1 message)

---

## License

Private — OpenClaw by TungND2k2
