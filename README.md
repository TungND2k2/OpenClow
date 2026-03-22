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
    Q -->|priority sort| C[🧠 Commander]

    C -->|phân rã task| S1[📋 Supervisor 1]
    C -->|phân rã task| S2[📋 Supervisor 2]

    S1 -->|giao việc| W1[⚙️ Worker 1]
    S1 -->|giao việc| W2[⚙️ Worker 2]
    S2 -->|giao việc| W3[⚙️ Worker 3]

    W1 & W2 & W3 -->|gọi tools| T[🔧 Tool Registry]

    T --> DB[(🗄️ PostgreSQL)]
    T --> S3[📦 S3 Storage]
    T --> KB[📚 Knowledge Base]

    KB -.->|kiến thức đã học| C

    style C fill:#4A90D9,color:#fff
    style S1 fill:#7B68EE,color:#fff
    style S2 fill:#7B68EE,color:#fff
    style W1 fill:#2ECC71,color:#fff
    style W2 fill:#2ECC71,color:#fff
    style W3 fill:#2ECC71,color:#fff
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

### 5. Phân quyền theo cấp bậc

```
Admin → cấp Manager, toàn quyền
Manager → cấp User/Sales/Staff, quản lý quy trình
User/Sales → sử dụng quy trình, hỏi đáp
Chưa đăng ký → /register → admin duyệt
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
       ├── decisions/       Audit trail
       ├── monitoring/      Health check, budget
       └── ...
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

## License

Private — OpenClaw by TungND2k2
