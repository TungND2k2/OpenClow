/**
 * Setup script: creates a demo tenant with a sales order workflow.
 * Run: npx tsx scripts/setup-demo.ts
 */
import "dotenv/config";
import { loadConfig } from "../src/config.js";
loadConfig();
import { runMigrations } from "../src/db/migrate.js";
runMigrations();

import { createTenant } from "../src/modules/tenants/tenant.service.js";
import { getDb } from "../src/db/connection.js";
import { workflowTemplates, formTemplates, businessRules, tenantUsers } from "../src/db/schema.js";
import { newId } from "../src/utils/id.js";
import { nowMs } from "../src/utils/clock.js";
import { registerAgent, heartbeat } from "../src/modules/agents/agent.service.js";
import { closeDb } from "../src/db/connection.js";

const now = nowMs();
const db = getDb();

// 1. Create tenant
const tenant = createTenant({
  name: "Demo Corp",
  config: { currency: "VND", timezone: "Asia/Ho_Chi_Minh" },
  aiConfig: { language: "vi", tone: "professional" },
});
console.log(`✅ Tenant: ${tenant.id} (${tenant.name})`);

// 2. Create order form
const formId = newId();
db.insert(formTemplates).values({
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
}).run();
console.log(`✅ Form: ${formId} (Sales Order Form)`);

// 3. Create approval rule
const ruleId = newId();
db.insert(businessRules).values({
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
}).run();
console.log(`✅ Rule: ${ruleId} (auto-escalate > 5M)`);

// 4. Create workflow template
const tmplId = newId();
db.insert(workflowTemplates).values({
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
}).run();
console.log(`✅ Workflow: ${tmplId} (Tạo Đơn Hàng)`);

// 5. Agents — created automatically by agent-pool on startup
console.log(`⏭️  Agents will be created by agent-pool on startup`);

// 6. Create admin user in DB (Telegram ID from env or arg)
const adminTelegramId = process.argv[2] ?? "1963992425";
const adminUserId = newId();
db.insert(tenantUsers).values({
  id: adminUserId,
  tenantId: tenant.id,
  channel: "telegram",
  channelUserId: adminTelegramId,
  displayName: "Admin",
  role: "admin",
  isActive: 1,
  createdAt: now,
  updatedAt: now,
}).run();
console.log(`✅ Admin user: telegram:${adminTelegramId} → role:admin`);

// Print .env snippet
console.log(`\n${"─".repeat(50)}`);
console.log(`Thêm vào file .env:\n`);
console.log(`TELEGRAM_DEFAULT_TENANT_ID=${tenant.id}`);
console.log(`\nChạy bot: npx tsx src/index.ts`);
console.log(`${"─".repeat(50)}`);

closeDb();
