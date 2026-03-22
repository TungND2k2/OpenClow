# Form State — Multi-step Form với Persistent Data

> Status: **DEPLOYED**

## Vấn đề

Form nhiều bước, user nhập đến bước N → hỏi lại bước trước → bot quên.
Nguyên nhân: chat history bị cắt khi quá dài.

## Giải pháp

### 1. Form State — lưu DB per user

Mỗi user có session riêng → form state riêng → data lưu DB ngay mỗi bước.

```
session.state.formState = {
  formName: "...",
  status: "in_progress",
  currentStep: N,
  totalSteps: M,
  data: { field1: value1, field2: value2, ... },
  pendingFields: [...]
}
```

- Concurrent users điền cùng form → mỗi người 1 state riêng
- Tắt app quay lại → data vẫn còn
- Form xong → auto lưu vào collection

### 2. Conversation Summary — tóm tắt thông minh

Mỗi 10 messages → auto tóm tắt → giữ summary + 5 messages gần nhất.

```
Prompt = [summary (~200 tokens)] + [5 recent messages] + [form context]
       = ~500 tokens thay vì 3000+
```

### 3. Prompt Injection

Khi user đang điền form, inject trạng thái vào prompt:

```
FORM ĐANG NHẬP: "..." (bước N/M)
ĐÃ ĐIỀN:
  1. Field A: value ✅
  2. Field B: value ✅
ĐANG CHỜ:
  3. Field C ← ĐANG CHỜ
  4. Field D
→ Gọi update_form_field(field_name, value) để lưu
```

## Tools

| Tool | Mô tả |
|------|--------|
| `start_form(form_name)` | Load form template từ DB, tạo session |
| `update_form_field(field_name, value)` | Lưu field vào DB ngay |
| `get_form_state()` | Xem trạng thái form |
| `cancel_form()` | Huỷ form |

## Flow

```
User: "nhập đơn"
  → start_form() → load fields → hỏi field 1

User: "abc"
  → update_form_field("Field 1", "abc") → lưu DB → hỏi field 2

User: "bước 1 nhập gì?"
  → get_form_state() → đọc DB → trả lời chính xác

User: "sửa field 1 thành xyz"
  → update_form_field("Field 1", "xyz") → update DB

Field cuối hoàn thành
  → status: "completed" → auto add_row vào collection
```

## TODO

- [ ] Auto `add_row` khi form complete
- [ ] Validation per field (min/max, required check)
- [ ] Form resume khi user quay lại sau thời gian dài
