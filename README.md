# OpenClaw

**Multi-Agent Orchestration System — Semi-Autonomous AI Workforce**

Hệ thống quản lý multi-bot AI, tự học, phân quyền dynamic, quản lý qua chat — không cần code.

---

## OpenClaw là gì?

OpenClaw biến mỗi bot Telegram thành **trợ lý AI thông minh** cho tổ chức. Mỗi bot có persona riêng, data riêng, users riêng — chạy trên cùng 1 hạ tầng.

```mermaid
graph TD
    SA[👑 Super Admin] -.->|quản lý bots| SYS

    subgraph SYS[🏗️ OpenClaw — 1 Process, N Bots]
        B1[🤖 Milo — Kinh doanh]
        B2[🤖 Zero — Tech]
        BN[🤖 Bot N — Custom]
    end

    U[👤 User — Telegram] -->|nhắn bot| B1 & B2 & BN
    B1 & B2 & BN -->|message + tenant_id| Q[📬 Message Queue<br/>5 concurrent]

    Q -->|priority sort| P[🔐 Permission Check<br/>CRUDM]
    P -->|allowed| C[🧠 Commander]
    P -->|denied| AR[📩 Xin quyền]
    AR -->|bắn 1 người| MGR[👔 Manager/Admin]
    MGR -->|/grant| P

    C -->|phân rã task| S1[📋 Supervisor 1]
    C -->|phân rã task| S2[📋 Supervisor 2]

    S1 -->|giao việc| W1[⚙️ Worker 1]
    S1 -->|giao việc| W2[⚙️ Worker 2]
    S2 -->|giao việc| W3[⚙️ Worker 3]

    W1 & W2 & W3 -->|gọi tools| T[🔧 Tool Registry<br/>30 tools]

    T --> DB[(🗄️ PostgreSQL<br/>tenant isolation)]
    T --> S3[📦 S3 Storage]
    T --> KB[📚 Knowledge Base<br/>self-learning]
    T --> AL[📝 Audit Log]

    KB -.->|kiến thức đã học| C

    style SA fill:#FFD700,color:#000
    style B1 fill:#4A90D9,color:#fff
    style B2 fill:#2ECC71,color:#fff
    style BN fill:#9B59B6,color:#fff
    style C fill:#4A90D9,color:#fff
    style P fill:#E74C3C,color:#fff
    style S1 fill:#7B68EE,color:#fff
    style S2 fill:#7B68EE,color:#fff
    style W1 fill:#2ECC71,color:#fff
    style W2 fill:#2ECC71,color:#fff
    style W3 fill:#2ECC71,color:#fff
    style AL fill:#F39C12,color:#fff
    style KB fill:#F39C12,color:#fff
```

```
Mỗi bot có riêng — data hoàn toàn tách biệt:
  🤖 Milo: persona kinh doanh, knowledge sale, đơn hàng, quy trình
  🤖 Zero: persona tech, knowledge DevOps, code snippets
  → Cùng 1 user nhắn 2 bot → 2 thế giới riêng biệt

Persona lưu DB — bot tự nhớ vai trò:
  User: "bạn là bot tech" → update_ai_config → lưu DB → restart vẫn nhớ
  User: "nhớ giùm stack: Node.js + Docker" → save_knowledge → lưu DB
```

---

## Tính năng chính

### 1. Multi-Bot — nhiều bot, 1 hệ thống

```
1 process chạy N bots cùng lúc
Mỗi bot = 1 tenant riêng: data, users, knowledge tách biệt
Super Admin quản lý tất cả bots
Thêm bot mới → tạo tenant + token → chạy ngay, không restart

Ví dụ:
  @milo_bot → bot quản lý kinh doanh (đơn hàng, quy trình, nhân sự)
  @zero_bot → bot hỗ trợ tech (code, server, DevOps)
  @sales_bot → bot riêng cho team sales
```

### 2. Bot tự nhớ persona — config lưu DB

```
User: "bạn là bot chuyên về tech"
→ Bot gọi update_ai_config → lưu persona vào DB
→ Restart vẫn nhớ

User: "đổi tên thành TechBot"
→ Bot gọi update_ai_config({bot_name: "TechBot"}) → lưu DB

User: "nhớ giùm tôi đang dùng Node.js + Docker"
→ Bot gọi save_knowledge → lưu knowledge DB
```

### 3. Tự học từ hội thoại (Self-Learning)

```
Lần 1: Manager dạy quy tắc phân loại, quy trình
→ Bot lưu vào Knowledge Base + Business Rules

Lần 2: User tạo task tương tự
→ Bot tự áp dụng quy tắc đã học
→ Không cần ai dạy lại

Knowledge tự dedup — cùng intent chỉ giữ 1 rule, tăng use_count
```

### 4. Quản lý dữ liệu qua chat

```
"Tạo bảng theo dõi đơn hàng"
→ Tạo collection trong DB

"Nhập đơn mới: KH A, 20 sản phẩm, deadline tuần sau"
→ Lưu vào DB thật

"Danh sách đơn chưa hoàn thành?"
→ Query DB, trả kết quả chính xác — không bịa

Smart search: filter DB trước khi gửi LLM
Pagination: > 20 rows → trả summary
```

### 5. Multi-step Form — không mất data

```
Form 19 bước → mỗi field lưu DB ngay
→ Bước 10, hỏi "bước 3 nhập gì?" → trả lời chính xác
→ Tắt app, quay lại → tiếp tục đúng chỗ
→ 3 người nhập cùng lúc → mỗi người 1 phiên riêng

Conversation auto-summary khi history dài
→ Prompt nhẹ (~500 tokens thay vì 3000+)
```

### 6. Phân quyền Dynamic (CRUDM)

```
C = Create, R = Read, U = Update, D = Delete, M = Manage (cấp quyền)

Admin → toàn quyền
Manager → quyền mặc định + cấp quyền cho staff (nếu có M)
Staff/Sales → quyền mặc định, xin thêm từ manager

Khi không đủ quyền:
  → Bot hỏi "Gửi yêu cầu cho [Manager X]?"
  → Bắn đúng 1 người (reports_to)
  → Manager: /grant user resource CRUD → cấp vĩnh viễn
  → Mọi thao tác lưu audit log
```

### 7. File & Vision

```
Upload PDF/DOCX/Excel → extract text + lưu S3
Upload ảnh → AI phân tích nội dung (vision)
"Đọc cẩm nang sale" → AI tự tìm file → đọc → trả lời từ nội dung thật
```

---

## Kiến trúc

```mermaid
graph LR
    subgraph Input
        TG[📱 Telegram Bots<br/>N bots parallel]
        MCP[🔌 MCP Server<br/>30 tools]
    end

    subgraph Core
        Q[📬 Queue<br/>5 concurrent]
        PERM[🔐 Permission<br/>CRUDM check]
        P[⚡ Pipeline<br/>Knowledge → Think → Tools → Learn]
        O[🔄 Orchestrator<br/>5s tick]
    end

    subgraph Data
        DB[(🗄️ PostgreSQL<br/>26 tables)]
        S3[📦 S3 Storage]
        KB[📚 Knowledge<br/>Self-Learning]
        AL[📝 Audit Log]
    end

    subgraph LLM
        L1[🧠 Strong LLM<br/>Commander]
        L2[⚡ Fast LLM<br/>Workers]
    end

    TG --> Q --> PERM --> P
    MCP --> P
    P --> DB & S3 & KB & AL
    P --> L1 & L2
    O --> P
    KB -.->|đã học| P

    style L1 fill:#4A90D9,color:#fff
    style L2 fill:#2ECC71,color:#fff
    style KB fill:#F39C12,color:#fff
    style PERM fill:#E74C3C,color:#fff
```

---

## Phân cấp hệ thống

```
Super Admin (owner hệ thống)
  │
  ├── Bot Milo (Tenant A — kinh doanh)
  │   ├── Admin A
  │   ├── Manager A1 (reports_to: Admin A)
  │   └── Staff/Sales (reports_to: Manager A1)
  │
  ├── Bot Zero (Tenant B — tech)
  │   ├── Admin B
  │   └── ...
  │
  └── Bot N (Tenant N)
      └── ...

Data hoàn toàn tách biệt giữa các bot
Cùng 1 user có thể ở nhiều bot với role khác nhau
```

---

## Cấu trúc thư mục

```
src/
  ├── bot/                  Multi-bot Telegram + queue + agent bridge
  ├── db/                   PostgreSQL schemas (Drizzle ORM)
  ├── mcp/                  MCP server (shared tool registry)
  ├── proxy/                LLM proxy routing
  └── modules/
       ├── agents/          Agent templates, pool, runner
       ├── collections/     Dynamic tables (CRUD) + owner tracking
       ├── conversations/   Session state + form state + summary
       ├── knowledge/       Self-learning (intent-based merge)
       ├── permissions/     Dynamic RBAC + approval flow + audit
       ├── tasks/           Task lifecycle
       ├── orchestration/   Dispatch, DAG, auto-assign
       ├── workflows/       Workflow + form + rules engine
       ├── storage/         S3 + PDF/DOCX/XLSX + vision
       ├── tenants/         Multi-tenant management
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
| `/grant <user> <resource> <access>` | admin/manager (cần M) | Cấp quyền (CRUDM) |
| `/deny <requestId>` | admin/manager | Từ chối yêu cầu quyền |
| `/revoke <user> <resource>` | admin/manager | Thu hồi quyền |
| `/permissions` | admin/manager | Xem yêu cầu quyền đang chờ |

---

## Triển khai

### Yêu cầu

- **Node.js** >= 22
- **PostgreSQL** >= 16
- **S3 storage** (cho file upload)
- **LLM API** (OpenAI-compatible hoặc CLI)

### Quick Start

```bash
git clone https://github.com/TungND2k2/OpenClaw.git
cd OpenClaw && npm install
cp .env.example .env    # sửa config
npx tsx scripts/setup-demo.ts <TELEGRAM_ID>
npx tsx src/index.ts
```

### Production (Ubuntu)

```bash
# Dependencies
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs postgresql mupdf-tools
npm install -g pm2

# PostgreSQL
sudo -u postgres createuser openclaw -P
sudo -u postgres createdb openclaw -O openclaw

# Deploy
cd /opt && git clone https://github.com/TungND2k2/OpenClaw.git
cd OpenClaw && npm install && cp .env.example .env
npx tsx scripts/setup-demo.ts <TELEGRAM_ID>
pm2 start "npx tsx src/index.ts" --name openclaw
pm2 save && pm2 startup
```

### Thêm bot mới (multi-bot)

```bash
# 1. Tạo bot trên @BotFather → lấy token
# 2. Insert tenant + token vào DB
# 3. Restart: pm2 restart openclaw
# → Bot mới tự start polling
```

### Update

```bash
cd /opt/OpenClaw && git pull && npm install && pm2 restart openclaw
```

---

## .env

```env
DATABASE_URL=postgresql://openclaw:openclaw123@localhost:5432/openclaw
NODE_ENV=production

# Telegram (fallback — bot tokens nên lưu trong DB)
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_DEFAULT_TENANT_ID=   # từ setup-demo

# S3
S3_ENDPOINT=https://s3.example.com
S3_REGION=us-east-1
S3_BUCKET=your-bucket
S3_ACCESS_KEY=
S3_SECRET_KEY=

# LLM
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
| Protocol | MCP (Model Context Protocol) |
| AI | LLM API (OpenAI-compatible) + CLI |
| Bot | Telegram Bot API (multi-bot long-polling) |
| Storage | S3-compatible |
| Process | PM2 |

---

## Docs

| Doc | Nội dung |
|-----|----------|
| [FORM-STATE.md](docs/FORM-STATE.md) | Multi-step form + conversation summary |
| [DB-ACCESS-CONTROL.md](docs/DB-ACCESS-CONTROL.md) | Dynamic permission + approval flow |
| [MULTI-BOT.md](docs/MULTI-BOT.md) | Multi-bot management + super admin |
| [BOT-HIERARCHY.md](docs/BOT-HIERARCHY.md) | Bot phân cấp theo tổ chức (planned) |
| [ROADMAP-LEARNED-ROUTING.md](docs/ROADMAP-LEARNED-ROUTING.md) | Tự học engine routing (planned) |

---

## Changelog

### v0.6.0 — Multi-Bot + Dynamic Persona
- **Multi-bot**: N bots chạy trong 1 process, mỗi bot 1 tenant riêng
- **Bot token lưu DB**: không cần .env cho mỗi bot
- **Super Admin**: quản lý toàn bộ hệ thống, tạo/stop bots
- **Dynamic persona**: user đổi vai trò bot qua chat → lưu DB → restart vẫn nhớ
- **Dynamic bot name**: tên bot lấy từ DB, không hardcode
- **MCP cleanup**: xoá 17 files duplicate, dùng shared tool registry (30 tools)
- **Runtime bot management**: `addBot()`, `removeBot()`, `listBots()`

### v0.5.0 — Dynamic Permissions + Audit Trail
- **`db_query` meta-tool**: generic CRUD với permission check
- **CRUDM permissions**: C/R/U/D + M (Manage — cấp quyền cho người khác)
- **Grant flow**: `/grant`, `/deny`, `/revoke` commands
- **Approval request**: bắn đúng 1 người (reports_to)
- **Owner tracking**: `created_by`, `updated_by` trên mọi record
- **Audit trail**: mọi thao tác lưu log

### v0.4.0 — Form State + Conversation Summary
- **Conversation Summary**: auto tóm tắt mỗi 10 messages
- **Form State**: multi-step form lưu per-user session trong DB
- **Tools**: `start_form`, `update_form_field`, `get_form_state`, `cancel_form`

### v0.3.0 — PostgreSQL + Smart Search
- SQLite → **PostgreSQL** (persistent, remote access)
- **Smart search**: `search_all(keyword)` filter trước khi gửi LLM
- **Pagination**: > 20 rows → summary
- **Knowledge dedup**: intent-based merge

### v0.2.0 — Agent System + Self-Learning
- Agent Templates — tạo agent qua chat
- Self-learning — intent-based knowledge rules
- Dynamic Collections — tạo bảng qua chat
- Image Vision — phân tích ảnh
- File parsing — PDF, DOCX, XLSX
- S3 Storage

### v0.1.0 — Foundation
- Telegram bot + message queue (5 concurrent)
- MCP server
- Orchestrator (health check, dispatch, DAG)
- Role-based access + registration flow
- Progress messages

---

## License

Private — OpenClaw by TungND2k2
