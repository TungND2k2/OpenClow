# Multi-Bot Management — Super Admin

> Status: **PLANNED**

## Phân cấp

```
Super Admin (owner hệ thống)
  │
  ├── Bot Milo (Tenant A)
  │   ├── Admin A (quản lý trong tenant)
  │   ├── Manager A1, A2
  │   └── Staff/Sales...
  │
  ├── Bot Zero (Tenant B)
  │   ├── Admin B
  │   └── ...
  │
  └── Bot X (Tenant C)
      └── ...
```

## Super Admin vs Admin

| | Super Admin | Admin (tenant) |
|---|---|---|
| Tạo/xoá bot | ✅ | ❌ |
| Start/Stop bot | ✅ | ❌ |
| Xem data cross-tenant | ✅ | ❌ |
| Thống kê toàn hệ thống | ✅ | ❌ |
| Quản lý users trong tenant | ✅ | ✅ |
| Cấp quyền trong tenant | ✅ | ✅ |
| Xem data tenant mình | ✅ | ✅ |

## Bot Token lưu DB

```sql
-- Chuyển từ .env sang tenants table
ALTER TABLE tenants ADD COLUMN bot_token TEXT;
ALTER TABLE tenants ADD COLUMN bot_status TEXT DEFAULT 'active'; -- active | stopped
ALTER TABLE tenants ADD COLUMN bot_username TEXT; -- @milo_suport_bot
```

## Super Admin table

```sql
CREATE TABLE super_admins (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,          -- "telegram"
  channel_user_id TEXT NOT NULL,  -- Telegram ID
  display_name TEXT,
  created_at BIGINT NOT NULL
);
```

## Master Bot

Super Admin quản lý qua 1 bot "master":

```
Super Admin nhắn Master Bot:

  "tạo bot mới"
  → Bot hỏi: tên? token? mô tả?
  → Tạo tenant + start polling

  "danh sách bots"
  → Milo: 2 users, 29 knowledge, running ✅
  → Zero: 0 users, stopped ⏸️

  "stop Milo"
  → Stop polling Milo

  "start Milo"
  → Resume polling

  "thống kê"
  → Tổng: 2 bots, 5 users, 42 knowledge, 13 files

  "xoá bot Zero"
  → Confirm → xoá tenant + data
```

## Startup Flow

```
System start
  → Đọc tenants từ DB (WHERE bot_status = 'active')
  → Mỗi tenant có bot_token → start polling
  → Message đến bot nào → route đúng tenant_id
  → Super Admin nhắn Master Bot → quản lý commands
```

## Data Isolation

```
User nhắn Milo → tenant_id = "tenant_milo" → chỉ thấy data Milo
User nhắn Zero → tenant_id = "tenant_zero" → chỉ thấy data Zero
Cùng 1 DB PostgreSQL, filter bằng tenant_id
Knowledge, files, collections, users — tất cả tách biệt
```

## TODO

- [ ] Chuyển bot_token từ .env vào tenants table
- [ ] Super Admin table + auth
- [ ] Master Bot commands (tạo/xoá/start/stop bot)
- [ ] Multi-bot polling (1 process, N bots)
- [ ] Cross-tenant dashboard cho Super Admin
