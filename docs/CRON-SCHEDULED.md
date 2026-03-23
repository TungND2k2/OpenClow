# Cron / Scheduled Tasks

## Mô tả

Cho phép user tạo task chạy tự động theo lịch — qua chat, không cần code.

## Ví dụ sử dụng

```
User: "mỗi sáng 8h gửi báo cáo đơn hàng hôm qua cho tôi"
Bot: → tạo cron: 0 8 * * * → chạy search_all("đơn hàng") → gửi Telegram

User: "mỗi thứ 2 nhắc team deadline tuần này"
Bot: → tạo cron: 0 9 * * 1 → query deadlines → gửi message

User: "mỗi 30 phút check server 103.252.74.52 còn sống không"
Bot: → tạo cron: */30 * * * * → ssh_exec("uptime") → alert nếu fail

User: "xoá cron báo cáo sáng"
Bot: → delete cron
```

## Tools

- `create_cron(name, schedule, action, args)` — tạo scheduled task
- `list_crons()` — xem danh sách
- `delete_cron(cron_id)` — xoá
- `pause_cron(cron_id)` / `resume_cron(cron_id)` — tạm dừng/tiếp

## DB Schema

```
scheduled_tasks:
  id TEXT PK
  tenant_id TEXT FK
  name TEXT
  schedule TEXT (cron expression: "0 8 * * *")
  action TEXT (tool name: "search_all", "ssh_exec", "list_rows")
  args JSONB (tool arguments)
  notify_user_id TEXT (gửi kết quả cho ai)
  notify_channel TEXT (telegram)
  status TEXT (active/paused/deleted)
  last_run_at BIGINT
  next_run_at BIGINT
  run_count INTEGER
  last_result TEXT
  created_by_user_id TEXT
  created_by_name TEXT
  created_at BIGINT
  updated_at BIGINT
```

## Flow

```
Orchestrator tick (5s):
  → Check scheduled_tasks WHERE status = 'active' AND next_run_at <= NOW
  → Cho mỗi task đến hạn:
    → executeTool(action, args)
    → Gửi kết quả cho notify_user_id qua Telegram
    → Update last_run_at, next_run_at, run_count, last_result
```

## Permission

- Admin: CRUD tất cả crons
- Manager: CRUD crons của mình + staff dưới quyền
- Staff/User: chỉ xem crons của mình
