# Pipeline Architecture

## So sanh voi cac framework

| Tieu chi | LangChain | CrewAI | OpenAI Assistants | OpenClaw |
|----------|-----------|--------|-------------------|----------|
| Pipeline | Chain-based | Task-based | Thread-based | **Middleware pipeline** |
| Tool discovery | Static | Static | Static schema | **DB-driven** |
| Multi-agent | RouterChain | Hierarchical/Seq | Single assistant | **Hierarchy + Persona** |
| Memory | Buffer/Summary | 3-tier | Thread auto | **Knowledge scorer + feedback** |
| Self-learning | Khong co | Training mode | Fine-tune | **Real-time merge/create** |
| Config | Code | Code/YAML | API | **100% DB** |

---

## Pipeline Flow

```mermaid
graph TD
    U[User Message] --> MW1

    subgraph Pipeline
        MW1[01-Feedback] --> MW2[02-Knowledge]
        MW2 --> MW3[03-Context]
        MW3 --> MW4[04-Route]
        MW4 --> MW5[05-Execute]
        MW5 --> MW6[06-Learn]
    end

    MW6 --> R[Response → Telegram]

    style MW1 fill:#f39c12,color:#fff
    style MW2 fill:#3498db,color:#fff
    style MW3 fill:#2ecc71,color:#fff
    style MW4 fill:#9b59b6,color:#fff
    style MW5 fill:#e74c3c,color:#fff
    style MW6 fill:#1abc9c,color:#fff
```

### Chi tiet tung middleware

#### 01-Feedback (Implicit Detection)

```mermaid
graph LR
    M1[Bot response truoc] --> FD{Detect}
    M2[User message hien tai] --> FD
    FD -->|"sai roi, lam lai"| NEG[Negative → giam use_count]
    FD -->|"ok, luu di"| POS[Positive → tang use_count]
    FD -->|chuyen topic| NEU[Neutral → skip]
```

- Khong hoi user "ban hai long khong?"
- Goi fast-api ngam de detect sentiment
- Update knowledge score tu dong

#### 02-Knowledge (RAG-lite Retrieval)

```mermaid
graph TD
    MSG[User Message] --> KW[Extract Keywords]
    KW --> Q[Query knowledge_entries]
    Q --> |per tenant_id| FILTER[Filter by tenant]
    FILTER --> SCORE[Score matching]
    SCORE -->|score > 0.3| INJECT[Inject vao context]
    SCORE -->|score < 0.3| SKIP[Skip]

    INJECT --> |"Khi hoi X → goi tool Y"| PROMPT[System Prompt]
```

- Keyword-based scoring (chua co vector embedding)
- Per-tenant isolation
- Rules co use_count — uu tien rules dung nhieu

#### 03-Context (Resource Assembly)

```mermaid
graph TD
    subgraph "Data Sources"
        RC[Resource Cache]
        FS[Form State]
        KN[Knowledge từ step 02]
        OB[Onboarding check]
        SM[Conversation Summary]
    end

    subgraph "Build Prompt"
        RC --> SP[System Prompt]
        FS --> SP
        KN --> SP
        OB --> SP
        SM --> SP
    end

    SP --> NEXT[04-Route]
```

**Resource Cache** (TODO — chua implement):
```
Startup hoac khi data thay doi → build cache:
{
  resources: [
    {type: "form", name: "Form nhap don", metadata: {fields: 19}},
    {type: "collection", name: "Don hang", metadata: {rows: 15}},
    {type: "workflow", name: "Tao Don Hang"},
    {type: "file", name: "cam_nang_sale.docx"},
    ...bat ky cai gi user tao
  ]
}
→ Inject ~200 chars vao prompt
→ Rebuild khi: add_row, create_collection, create_form, upload...
```

#### 04-Route (Engine + Agent Selection)

```mermaid
graph TD
    MSG[Message + Context] --> CHECK{Personas?}
    CHECK -->|>= 2 personas + msg > 15 chars| MP[Multi-Persona Mode]
    CHECK -->|0-1 personas| CMD[Commander Direct]

    MP --> ROUTE[routeToPersonas → chon ai tham gia]
    ROUTE --> CONV[Persona Conversation]

    CMD --> ENGINE{Engine}
    ENGINE --> CLI[claude-cli]
```

#### 05-Execute (LLM + Tool Loop)

```mermaid
graph TD
    PROMPT[System Prompt + History] --> LLM[LLM Call]
    LLM --> CHECK{Response type?}

    CHECK -->|tool_calls| EXEC[Execute Tools]
    EXEC --> RESULT[Tool Results]
    RESULT --> LLM

    CHECK -->|text only| DONE[Response Text]

    subgraph "Multi-Persona"
        P1["💰 Finance Agent"] -->|gui ngay| TG1[Telegram msg 1]
        P2["📦 Order Agent"] -->|gui ngay| TG2[Telegram msg 2]
        P3["🧑‍💼 PM"] -->|gui ngay| TG3[Telegram msg 3]
    end
```

- Tool loop: LLM goi tool → execute → tra ket qua → LLM tiep tuc
- Max 10 loops (tranh infinite)
- Multi-persona: moi agent gui message ngay khi xong

#### 06-Learn (Self-Learning)

```mermaid
graph TD
    RESULT[Tool Calls Results] --> CHECK{Co tools?}
    CHECK -->|Co| MERGE[mergeOrCreateRule]
    CHECK -->|Khong| SKIP[Skip]

    MERGE --> FIND{Rule trung intent?}
    FIND -->|Co| UPDATE[Merge keywords + tang use_count]
    FIND -->|Chua| CREATE[Tao rule moi]

    UPDATE --> DB[(Knowledge DB)]
    CREATE --> DB

    ERR[Pipeline Error] --> ANTI[Save anti_pattern]
    ANTI --> DB
```

- Intent = sorted tool names (vd: "add_row,list_rows")
- Cung intent → merge keywords, tang use_count
- Error → luu anti_pattern de tranh lap lai
- Per-tenant isolation

---

## Multi-Agent Conversation

```mermaid
sequenceDiagram
    participant U as User
    participant C as Commander
    participant F as 💰 Finance
    participant O as 📦 Order
    participant PM as 🧑‍💼 PM

    U->>C: "Don PE-001 da thanh toan"
    C->>C: Route → Finance, Order, PM
    C->>F: Think: "Don da thanh toan"
    F-->>U: "Da ghi nhan $1,030 ✅"
    F->>O: Context: Finance da confirm
    O-->>U: "PE-001 → SAN XUAT ✅"
    O->>PM: Context: Order da update
    PM-->>U: "Tong hop: thanh toan ✅, san xuat ✅"
```

- Moi persona gui message ngay khi xong (streaming)
- Persona sau doc response cua persona truoc
- Commander khong xu ly — chi route

---

## Gaps can fix (Priority order)

### 1. Generic Resource Cache (High)
```
Hien tai: context khong biet forms/templates ton tai
Can: startup build cache tu DB, inject vao prompt
Pattern: Observer — khi data thay doi → rebuild cache
```

### 2. Tool Registry Dynamic Dispatch (High)
```
Hien tai: switch/case 30+ tools
Can: Map<string, ToolHandler> — register at startup
Them tool moi = register function, khong sua switch
```

### 3. Vector Embedding cho Knowledge (Medium)
```
Hien tai: keyword matching (score thap, match sai)
Can: embedding model (OpenAI/local) + cosine similarity
Se tang chat luong retrieval dang ke
```

### 4. Context Window Management (Medium)
```
Hien tai: khong dem tokens, co the vuot context window
Can: token counter + priority truncation
  knowledge > form > files > old history
```

### 5. Event-driven Agent Communication (Medium)
```
Hien tai: agents chi trao doi khi user nhan
Can: data thay doi → event → trigger agents tu dong
  update_row("orders", status="PAID") → trigger Production Agent
```
