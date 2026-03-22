/**
 * Setup script: creates a demo tenant with a sales order workflow.
 * Run: npx tsx scripts/setup-demo.ts
 */
import "dotenv/config";
import { loadConfig } from "../src/config.js";
loadConfig();
import { runMigrations } from "../src/db/migrate.js";
await runMigrations();

import { createTenant } from "../src/modules/tenants/tenant.service.js";
import { getDb } from "../src/db/connection.js";
import { workflowTemplates, formTemplates, businessRules, tenantUsers } from "../src/db/schema.js";
import { newId } from "../src/utils/id.js";
import { nowMs } from "../src/utils/clock.js";
// agents created by agent-pool on startup
import { closeDb } from "../src/db/connection.js";

const now = nowMs();
const db = getDb();

// 1. Create tenant with AI config (prompt, tools, rules — all in DB, not hardcoded)
const tenant = await createTenant({
  name: "Demo Corp",
  config: { currency: "VND", timezone: "Asia/Ho_Chi_Minh" },
  aiConfig: {
    language: "vi",
    tone: "professional",
    bot_name: "Milo",
    bot_intro: "trợ lý AI",

    // System prompt template — {{variables}} sẽ được thay runtime
    prompt_template: `Bạn là {{bot_name}} — {{bot_intro}} của {{tenant_name}}. Luôn xưng "{{bot_name}}" khi giao tiếp.

USER: {{user_name}} | ROLE: {{user_role}}
QUYỀN: {{user_permissions}}

{{tool_instructions}}

QUY TẮC:
{{rules}}

{{custom_instructions}}`,

    // Quy tắc mặc định — admin sửa qua chat
    rules: [
      "Khi có KNOWLEDGE BASE → ƯU TIÊN dùng, trả lời nhanh",
      "Khi user nhắc đến file/cẩm nang/tài liệu → TỰ ĐỘNG gọi list_files → read_file_content → trả lời. KHÔNG hỏi lại user ID hay tên file",
      "Khi list FILES ĐÃ UPLOAD có sẵn → dùng file_id từ đó, KHÔNG cần gọi list_files",
      "KHÔNG tự bịa nội dung — phải dựa trên dữ liệu thật (knowledge/file/DB)",
      "Ngắn gọn, thực tế, đúng trọng tâm câu hỏi",
      "Gọi tool NGAY khi có đủ thông tin, không hỏi lại user",
    ],

    // Tool definitions — admin thêm/sửa/xoá qua chat
    tools: {
      business: [
        { name: "list_workflows", desc: "Xem danh sách quy trình" },
        { name: "create_workflow", desc: "Tạo quy trình", args: "name, description, domain, stages[{id,name,type}]" },
        { name: "create_form", desc: "Tạo form", args: "name, fields[{id,label,type,required}]" },
        { name: "create_rule", desc: "Tạo business rule", args: "name, domain, rule_type, conditions, actions" },
        { name: "save_tutorial", desc: "Lưu tutorial", args: "title, content, target_role, domain" },
        { name: "save_knowledge", desc: "Lưu knowledge", args: "type, title, content, domain, tags[]" },
        { name: "list_files", desc: "Xem file đã upload", args: "limit?" },
        { name: "read_file_content", desc: "Đọc nội dung file (DOCX/TXT/CSV)", args: "file_id" },
        { name: "get_file", desc: "Xem metadata file", args: "file_id" },
        { name: "send_file", desc: "Gửi file cho user", args: "file_id" },
        { name: "list_users", desc: "Xem users" },
        { name: "set_user_role", desc: "Đổi role", args: "channel, channel_user_id, role" },
        { name: "get_dashboard", desc: "Dashboard hệ thống" },
        { name: "search_knowledge", desc: "Tìm knowledge đã học", args: "domain?, tags?" },
        { name: "create_collection", desc: "Tạo bảng dữ liệu mới (ví dụ: đơn hàng, khách hàng)", args: "name, description?, fields[{name,type,required?}]" },
        { name: "list_collections", desc: "Xem danh sách bảng dữ liệu" },
        { name: "add_row", desc: "Thêm dòng vào bảng (LƯU DATA THẬT VÀO DB)", args: "collection (tên bảng), data{key:value}" },
        { name: "list_rows", desc: "Xem dữ liệu trong bảng", args: "collection (tên bảng), limit?" },
        { name: "update_row", desc: "Cập nhật dòng", args: "row_id, data{key:value}" },
        { name: "delete_row", desc: "Xoá dòng", args: "row_id" },
      ],
      agent_management: [
        { name: "create_agent_template", desc: "Tạo template agent mới", args: "name, role, system_prompt, capabilities[], tools[], engine?" },
        { name: "list_agent_templates", desc: "Xem templates", args: "role?, status?" },
        { name: "spawn_agent", desc: "Tạo agent từ template", args: "template_id?, template_name?, count?" },
        { name: "kill_agent", desc: "Tắt agent", args: "agent_id" },
        { name: "list_agents", desc: "Xem agents đang chạy", args: "role?, status?" },
      ],
    },

    // Permission labels per role
    role_permissions: {
      admin: "ADMIN — tạo/sửa quy trình, tutorial, rules, quản lý user, quản lý agents",
      manager: "MANAGER — tạo/sửa quy trình, tutorial, quản lý staff",
      staff: "STAFF — sử dụng quy trình, hỏi đáp",
      user: "USER — sử dụng quy trình có sẵn, hỏi đáp",
    },

    custom_instructions: "",
  },
});
console.log(`✅ Tenant: ${tenant.id} (${tenant.name})`);

// 2. Create order form
const formId = newId();
await db.insert(formTemplates).values({
  id: formId,
  tenantId: tenant.id,
  name: "Sales Order Form",
  schema: JSON.stringify({
    fields: [
      { id: "customer_name", label: "Tên khách hàng", type: "text", required: true, ai_prompt_hint: "Tên đầy đủ của khách hàng?" },
      { id: "phone", label: "Số điện thoại", type: "phone", required: true, ai_prompt_hint: "Số điện thoại liên lạc?" },
      { id: "product", label: "Sản phẩm", type: "select", required: true, options: ["Gói A - 500K", "Gói B - 1M", "Gói C - 2M"], ai_prompt_hint: "Chọn gói sản phẩm:\n1. Gói A - 500K\n2. Gói B - 1M\n3. Gói C - 2M" },
      { id: "quantity", label: "Số lượng", type: "number", required: true, validation: { min: 1, max: 100 }, ai_prompt_hint: "Số lượng đặt mua?" },
      { id: "notes", label: "Ghi chú", type: "text", required: false, ai_prompt_hint: "Ghi chú thêm (nếu có, gõ 'skip' để bỏ qua):" },
    ],
  }),
  uiHints: JSON.stringify({ language: "vi" }),
  version: 1,
  status: "active",
  createdAt: now,
  updatedAt: now,
});
console.log(`✅ Form: ${formId} (Sales Order Form)`);

// 3. Create approval rule
const ruleId = newId();
await db.insert(businessRules).values({
  id: ruleId,
  tenantId: tenant.id,
  name: "Đơn hàng > 5M cần Manager duyệt",
  description: "Tự động escalate khi giá trị đơn > 5.000.000 VND",
  domain: "sales",
  ruleType: "approval",
  conditions: JSON.stringify({
    type: "comparison",
    field: "form_data.total",
    operator: "gt",
    value: 5000000,
  }),
  actions: JSON.stringify([{ type: "escalate", params: { to_role: "manager" } }]),
  priority: 10,
  status: "active",
  createdAt: now,
  updatedAt: now,
});
console.log(`✅ Rule: ${ruleId} (auto-escalate > 5M)`);

// 4. Create workflow template
const tmplId = newId();
await db.insert(workflowTemplates).values({
  id: tmplId,
  tenantId: tenant.id,
  name: "Tạo Đơn Hàng",
  description: "Quy trình tạo đơn hàng qua chat",
  domain: "sales",
  version: 1,
  stages: JSON.stringify([
    {
      id: "collect",
      name: "Thu thập thông tin",
      type: "form",
      form_id: formId,
      next_stage_id: "confirm",
    },
    {
      id: "confirm",
      name: "Xác nhận đơn hàng",
      type: "notification",
      notification_config: {
        channel: "telegram",
        template: "📋 <b>Xác nhận đơn hàng</b>\nĐang xử lý đơn hàng của bạn...",
        recipients: [],
      },
      next_stage_id: "complete",
    },
    {
      id: "complete",
      name: "Hoàn tất",
      type: "notification",
      notification_config: {
        channel: "telegram",
        template: "✅ <b>Đơn hàng đã được ghi nhận!</b>\nCảm ơn bạn, đội ngũ sẽ liên hệ sớm nhất.",
        recipients: [],
      },
    },
  ]),
  triggerConfig: JSON.stringify({ command: "/new_1" }),
  status: "active",
  createdAt: now,
  updatedAt: now,
});
console.log(`✅ Workflow: ${tmplId} (Tạo Đơn Hàng)`);

// 5. Agents — created automatically by agent-pool on startup
console.log(`⏭️  Agents will be created by agent-pool on startup`);

// 6. Create admin user in DB (Telegram ID from env or arg)
const adminTelegramId = process.argv[2] ?? "1963992425";
const adminUserId = newId();
await db.insert(tenantUsers).values({
  id: adminUserId,
  tenantId: tenant.id,
  channel: "telegram",
  channelUserId: adminTelegramId,
  displayName: "Admin",
  role: "admin",
  isActive: true,
  createdAt: now,
  updatedAt: now,
});
console.log(`✅ Admin user: telegram:${adminTelegramId} → role:admin`);

// Print .env snippet
console.log(`\n${"─".repeat(50)}`);
console.log(`Thêm vào file .env:\n`);
console.log(`TELEGRAM_DEFAULT_TENANT_ID=${tenant.id}`);
console.log(`\nChạy bot: npx tsx src/index.ts`);
console.log(`${"─".repeat(50)}`);

closeDb();
