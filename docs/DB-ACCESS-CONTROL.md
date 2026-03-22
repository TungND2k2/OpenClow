# DB Access Control — Dynamic Permission + Approval Flow

> Status: **PLANNED**

## 1. Meta-tool `db_query`

```
db_query(table, action, filter?, data?)
  • action: "list" | "get" | "create" | "update" | "delete"
  • table: tên bảng
  • filter: điều kiện lọc
  • data: dữ liệu tạo/sửa
  • auto-inject: created_by, updated_by từ user hiện tại
```

## 2. Phân quyền Dynamic

### Nguyên tắc

- **Admin**: full quyền mặc định, không cần hỏi ai
- **Manager**: có quyền mặc định (tạo form, workflow, quản lý staff). Khi cần quyền ngoài → hệ thống **hỏi Admin**
- **Staff/Sales**: có quyền mặc định (xem, tạo đơn). Khi cần quyền ngoài → hệ thống **hỏi người quản lý trực tiếp** (1 người duy nhất)

### Quyền mặc định

```
admin:     full — không giới hạn
manager:   create/read/update form, workflow, collection, rows, rules
staff:     create/read collection_rows, read form, read collection
sales:     create/read collection_rows, read form, read collection
user:      read collection_rows (theo phân quyền bộ phận)
```

### Khi không đủ quyền → Xin quyền (Grant flow)

Xin quyền = xin **cả nhóm quyền** trên resource, không phải duyệt từng thao tác.

```
Staff Lan muốn tạo form nhưng không có quyền
  → Bot: "Bạn chưa có quyền trên form_templates.
          Gửi yêu cầu xin quyền cho Manager Kristina?"
  → Lan: "ok"
  → Bot gửi Kristina (chỉ 1 người):
    "🔔 Lan xin quyền trên form_templates
     /grant lan form_templates CRUD
     /grant lan form_templates CRU
     /deny lan form_templates"
  → Kristina: "/grant lan form_templates CRU"
  → Lan có quyền Create/Read/Update (không Delete) — vĩnh viễn
  → Từ giờ Lan tự tạo/sửa form thoải mái, không cần hỏi lại
```

### Chỉ bắn 1 người — không loạn

```
tenant_users:
  ├── Tùng (admin)
  ├── Kristina (manager) → reports_to: null (báo admin)
  ├── Lan (staff) → reports_to: "5886721404" (Kristina)
  ├── Mai (sales) → reports_to: "5886721404" (Kristina)
  └── Hùng (staff) → reports_to: "1963992425" (Tùng - admin)

Lan xin quyền → bắn Kristina (1 người)
Hùng xin quyền → bắn Tùng (1 người)
Kristina xin quyền → bắn Tùng (admin duy nhất)
```

### Grant options

```
/grant <user> <resource> CRUD   — full quyền (Create/Read/Update/Delete)
/grant <user> <resource> CRU    — không cho xoá
/grant <user> <resource> CR     — chỉ tạo + xem
/grant <user> <resource> R      — chỉ xem
/revoke <user> <resource>       — thu hồi quyền đã cấp
```

Quyền lưu vĩnh viễn trong `extra_permissions` cho đến khi bị `/revoke`.

## 3. DB Schema

### Thêm fields vào tenant_users

```sql
ALTER TABLE tenant_users ADD COLUMN reports_to TEXT;        -- ID người quản lý trực tiếp
ALTER TABLE tenant_users ADD COLUMN extra_permissions JSONB; -- quyền được cấp thêm
-- extra_permissions: ["delete:collection_rows", "update:form_templates"]
```

### Bảng permission_requests

```sql
CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,         -- user xin quyền
  requester_name TEXT,
  approver_id TEXT NOT NULL,          -- người duyệt (1 người)
  action TEXT NOT NULL,               -- "delete"
  resource_table TEXT NOT NULL,       -- "collection_rows"
  resource_id TEXT,                   -- ID record cụ thể
  description TEXT,                   -- "Xoá đơn DTV-001"
  status TEXT DEFAULT 'pending',      -- pending | approved | rejected
  permanent BOOLEAN DEFAULT FALSE,    -- cấp vĩnh viễn?
  created_at BIGINT,
  resolved_at BIGINT
);
```

## 4. Owner Tracking

Mọi bảng thêm:
```sql
created_by_user_id TEXT    -- Telegram user ID
created_by_name TEXT       -- Tên hiển thị
updated_by_user_id TEXT
updated_by_name TEXT
```

`db_query` auto-inject owner info khi create/update.

## 5. Confirm trước action nguy hiểm

Chỉ áp dụng khi user **đã có quyền** — hỏi xác nhận 1 lần rồi làm:

```
Manager xoá form (có quyền delete):
  Bot: "⚠️ Chắc chắn xoá 'Form X'? Form có 19 fields. Gõ 'xác nhận'"
  Manager: "xác nhận"
  Bot: → xoá → "Đã xoá"

Staff xoá đơn (không có quyền delete):
  Bot: "Bạn chưa có quyền xoá. Gửi yêu cầu xin quyền cho Kristina?"
  → Nếu OK → Grant flow (xin cả quyền Delete, không phải duyệt từng đơn)
```

## 6. Audit Trail

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_name TEXT,
  user_role TEXT,
  action TEXT NOT NULL,          -- create/update/delete
  resource_table TEXT NOT NULL,
  resource_id TEXT,
  before_data JSONB,
  after_data JSONB,
  permission_request_id TEXT,    -- nếu qua approval flow
  created_at BIGINT
);
```

## Flow tổng quát

```
User thao tác (ví dụ: update form_templates)
  │
  ├── 1. Check quyền mặc định (theo role)
  │     ├── admin → full → thực thi
  │     └── Khác → check tiếp
  │
  ├── 2. Check extra_permissions (đã được grant trước?)
  │     ├── Có "U" trên form_templates → có quyền
  │     └── Không có → bước 3
  │
  ├── 3. Có quyền
  │     ├── Action nguy hiểm (delete)? → confirm "chắc chắn?" → thực thi
  │     └── Action bình thường → thực thi ngay
  │
  ├── 4. Không có quyền → Grant Flow
  │     ├── Tìm reports_to (1 người duy nhất)
  │     ├── Bot hỏi user: "Gửi yêu cầu xin quyền cho [tên]?"
  │     ├── User OK → gửi thông báo cho người quản lý
  │     ├── Manager/Admin: /grant user resource CRUD → cấp vĩnh viễn
  │     ├── Manager/Admin: /deny user resource → từ chối
  │     └── Sau khi được grant → user tự thao tác thoải mái
  │
  └── 5. Lưu audit_logs (mọi thao tác)
```

## TODO

- [ ] Migration: `reports_to`, `extra_permissions`, `permission_requests`, `audit_logs`
- [ ] `db_query` tool với permission check
- [ ] Approval flow (gửi Telegram + `/approve_perm` + `/reject_perm`)
- [ ] Owner tracking auto-inject
- [ ] Audit trail logging
