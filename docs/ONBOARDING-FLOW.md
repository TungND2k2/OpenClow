# Onboarding Flow — Bot chủ động dẫn dắt user

## Mô tả

Sau khi user config bot xong (persona, tên, ngành nghề), bot **chủ động** đặt câu hỏi để:
1. Hiểu nghiệp vụ user
2. Đề xuất workers phù hợp
3. Tạo bảng, form, workflow tự động
4. Import data có sẵn (file, cẩm nang)
5. Setup cron báo cáo

User cảm giác có **trợ lý thông minh** setup hệ thống cho mình.

## Flow

```
Phase 1 — Hiểu nghiệp vụ (ngay sau config persona):
  Bot: "Tôi hiểu bạn muốn bot về [ngành X]. Cho tôi biết thêm:
        1. Công ty bạn làm gì? (sản phẩm/dịch vụ chính)
        2. Bao nhiêu người sẽ dùng bot? (roles gì)
        3. Bạn cần quản lý gì nhất? (đơn hàng, dự án, khách hàng...)"

Phase 2 — Đề xuất workers:
  Bot phân tích câu trả lời → đề xuất workers:
  "Dựa trên nghiệp vụ của bạn, tôi đề xuất tạo:
   🧑‍💼 [Worker A] — [mô tả]
   📦 [Worker B] — [mô tả]
   📊 [Worker C] — [mô tả]
   Tạo luôn?"

Phase 3 — Import data:
  Bot: "Bạn có sẵn tài liệu nào không?
        - Cẩm nang sản phẩm / dịch vụ
        - Danh sách khách hàng
        - Quy trình làm việc
        Gửi file → tôi đọc và tạo bảng tự động."

Phase 4 — Setup automation:
  Bot: "Tôi đề xuất tự động hóa:
        ⏰ Báo cáo doanh thu mỗi tối 9h
        ⏰ Nhắc deadline đơn hàng mỗi sáng 8h
        ⏰ Check server mỗi 30 phút (nếu có)
        Bật những cái nào?"

Phase 5 — Hoàn thành:
  Bot: "✅ Hệ thống đã sẵn sàng!
        - 3 workers đang hoạt động
        - 2 bảng dữ liệu đã tạo
        - 1 form nhập đơn
        - 2 cron tự động

        Bạn có thể bắt đầu dùng ngay. Hỏi tôi bất cứ gì!"
```

## Cơ chế

1. Sau khi `update_ai_config` được gọi (config persona) → trigger onboarding
2. Bot lưu onboarding state trong session: `{ phase: 1, answers: {} }`
3. Mỗi phase: bot hỏi → user trả lời → bot xử lý → chuyển phase tiếp
4. Bot tự gọi tools: create_agent_template, create_collection, create_cron...
5. Onboarding xong → lưu knowledge: "Hệ thống đã setup cho [ngành X]"

## Không hardcode ngành nghề

Bot KHÔNG có danh sách ngành cố định. Nó:
- Đọc persona + user answers
- Dùng LLM suy luận workers/tables/forms phù hợp
- Đề xuất → user confirm → tạo

Mỗi ngành khác nhau → đề xuất khác nhau:
- Shop thời trang → Sales, Order Manager, Report
- Agency marketing → Content Creator, Campaign Manager, Client Tracker
- Startup tech → PM, Tech Lead, QA
- Phòng khám → Reception, Doctor Assistant, Appointment Manager
