# Learned Routing — Tự học engine routing (PENDING)

> Status: PENDING — token nhiều, dùng CLI trước. Build khi cần tối ưu chi phí.

## Mục tiêu

Milo tự học câu hỏi nào cần CLI (tool calling), câu nào fast-api đủ.
Giảm 70-80% requests xuống fast-api (2s thay vì 15s).

## Thiết kế

### 3 Layers

```
Layer 1 — Base Rules (cố định):
  • Greeting < 20 chars → fast-api
  • Có file/ảnh upload kèm → CLI
  • Admin + quản lý/tạo/xoá → CLI
  • Message chứa ID (01KM..., DTV-...) → CLI

Layer 2 — Learned Rules (knowledge DB):
  • CLI không gọi tool → lưu "intent → fast-api đủ"
  • CLI có gọi tool → lưu "intent → BẮT BUỘC CLI"

Layer 3 — Default:
  • Không match → CLI (an toàn)
```

### Knowledge schema mới

```sql
-- Thêm field engine vào knowledge_entries
ALTER TABLE knowledge_entries ADD COLUMN recommended_engine TEXT DEFAULT 'claude-cli';
```

### Flow

```
Request đến
  → Check Layer 1 (base rules)
  → Check Layer 2 (knowledge match?)
    → Có: dùng engine từ rule
    → Không: Layer 3 → CLI
  → Sau response:
    → CLI không gọi tool → update rule: fast-api
    → CLI gọi tool → update rule: CLI
```

### Kết quả kỳ vọng

Sau 1 tuần: 70% câu hỏi hàng ngày → fast-api (2s)
Sau 1 tháng: 80%+ → fast-api, chỉ câu mới/phức tạp → CLI

## Điều kiện trigger build

- Khi token bắt đầu hạn chế
- Khi response time trở thành bottleneck
- Khi có > 50 users đồng thời
