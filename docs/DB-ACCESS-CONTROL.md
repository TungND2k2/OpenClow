# DB Access Control — Phân quyền + Confirm + Owner Tracking

> Status: **PLANNED**

## 1. Meta-tool `db_query` — thay thế hàng chục tools riêng

```
db_query(table, action, filter?, data?)
  • action: "list" | "get" | "create" | "update" | "delete"
  • table: tên bảng (whitelist theo role)
  • filter: điều kiện lọc
  • data: dữ liệu tạo/sửa
  • auto-inject: created_by, updated_by từ user hiện tại
```

## 2. Phân quyền theo role

```
admin:
  • form_templates — full CRUD
  • workflow_templates — full CRUD
  • business_rules — full CRUD
  • agent_templates — full CRUD
  • tenant_users — full CRUD
  • collections — full CRUD
  • collection_rows — full CRUD
  • knowledge_entries — full CRUD

manager:
  • form_templates — create, read, update (chỉ records mình tạo)
  • workflow_templates — create, read, update (chỉ records mình tạo)
  • business_rules — create, read
  • collections — create, read, update
  • collection_rows — full CRUD
  • knowledge_entries — read

sales/staff:
  • form_templates — read only
  • collections — read only
  • collection_rows — create, read (chỉ records mình tạo)

user:
  • collection_rows — read (theo phân quyền bộ phận)
```

## 3. Confirm trước khi thực thi

Các action nguy hiểm cần confirm:
- **delete** bất kỳ resource
- **update** form_templates, workflow_templates (thay đổi cấu trúc)
- **update** tenant_users (đổi role)

Flow:
```
Manager: "xoá form nhập đơn hàng"
Bot: "⚠️ Bạn chắc chắn muốn xoá form 'Form nhập đơn hàng'?
      Form này có 19 fields, đã được sử dụng 5 lần.
      Gõ 'xác nhận' để xoá hoặc 'huỷ' để giữ lại."
Manager: "xác nhận"
Bot: → thực thi delete → "Đã xoá form."
```

Lưu pending action trong conversation state:
```
session.state.pendingAction = {
  tool: "db_query",
  args: { table: "form_templates", action: "delete", filter: { id: "..." } },
  description: "Xoá form 'Form nhập đơn hàng'",
  expiresAt: Date.now() + 60000  // hết hạn sau 60s
}
```

## 4. Owner tracking

Mọi bảng thêm fields:
```sql
ALTER TABLE form_templates ADD COLUMN created_by_user_id TEXT;
ALTER TABLE form_templates ADD COLUMN created_by_name TEXT;
ALTER TABLE form_templates ADD COLUMN updated_by_user_id TEXT;
ALTER TABLE form_templates ADD COLUMN updated_by_name TEXT;

-- Tương tự cho: workflow_templates, business_rules,
-- collections, collection_rows, knowledge_entries
```

Khi `db_query` thực thi:
- **create** → auto set `created_by_user_id`, `created_by_name`
- **update** → auto set `updated_by_user_id`, `updated_by_name`
- **delete** → log vào audit trail trước khi xoá

## 5. Audit Trail

Mọi thao tác qua `db_query` đều lưu log:
```
audit_logs = {
  id, user_id, user_name, user_role,
  table, action, record_id,
  before_data, after_data,
  confirmed: true/false,
  created_at
}
```

## TODO

- [ ] Tạo `db_query` tool
- [ ] Phân quyền matrix theo role
- [ ] Confirm flow (pending action trong session)
- [ ] Migration thêm owner fields
- [ ] Audit trail table + logging
