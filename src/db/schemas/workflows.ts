import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { tasks } from "./tasks.js";
import { tenants } from "./tenants.js";

// ============================================================
// workflow_templates
// ============================================================
export const workflowTemplates = pgTable(
  "workflow_templates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    description: text("description"),
    domain: text("domain"),
    version: integer("version").notNull().default(1),
    stages: jsonb("stages").notNull(),
    triggerConfig: jsonb("trigger_config"),
    config: jsonb("config"),
    status: text("status")
      .notNull()
      .default("draft"),
    createdByUserId: text("created_by_user_id"),
    createdByName: text("created_by_name"),
    updatedByUserId: text("updated_by_user_id"),
    updatedByName: text("updated_by_name"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_wf_templates_tenant_name_ver").on(
      table.tenantId,
      table.name,
      table.version
    ),
    index("idx_wf_templates_tenant").on(table.tenantId),
    index("idx_wf_templates_domain").on(table.domain),
  ]
);

// ============================================================
// form_templates
// ============================================================
export const formTemplates = pgTable(
  "form_templates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    schema: jsonb("schema").notNull(),
    uiHints: jsonb("ui_hints"),
    version: integer("version").notNull().default(1),
    status: text("status")
      .notNull()
      .default("active"),
    createdByUserId: text("created_by_user_id"),
    createdByName: text("created_by_name"),
    updatedByUserId: text("updated_by_user_id"),
    updatedByName: text("updated_by_name"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_form_templates_tenant").on(table.tenantId)]
);

// ============================================================
// business_rules
// ============================================================
export const businessRules = pgTable(
  "business_rules",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    description: text("description"),
    domain: text("domain"),
    ruleType: text("rule_type").notNull(),
    conditions: jsonb("conditions").notNull(),
    actions: jsonb("actions").notNull(),
    priority: integer("priority").notNull().default(0),
    status: text("status")
      .notNull()
      .default("active"),
    createdByUserId: text("created_by_user_id"),
    createdByName: text("created_by_name"),
    updatedByUserId: text("updated_by_user_id"),
    updatedByName: text("updated_by_name"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_business_rules_tenant").on(table.tenantId),
    index("idx_business_rules_domain").on(table.domain),
    index("idx_business_rules_type").on(table.ruleType),
  ]
);

// ============================================================
// workflow_instances
// ============================================================
export const workflowInstances = pgTable(
  "workflow_instances",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => workflowTemplates.id),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    initiatedBy: text("initiated_by").notNull(),
    currentStageId: text("current_stage_id"),
    status: text("status")
      .notNull()
      .default("active"),
    formData: jsonb("form_data").notNull().default({}),
    contextData: jsonb("context_data")
      .notNull()
      .default({}),
    taskId: text("task_id").references(() => tasks.id),
    conversationId: text("conversation_id"),
    channel: text("channel"),
    history: jsonb("history").notNull().default([]),
    error: text("error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    completedAt: bigint("completed_at", { mode: "number" }),
  },
  (table) => [
    index("idx_wf_instances_template").on(table.templateId),
    index("idx_wf_instances_tenant").on(table.tenantId),
    index("idx_wf_instances_status").on(table.status),
    index("idx_wf_instances_task").on(table.taskId),
  ]
);

// ============================================================
// workflow_approvals
// ============================================================
export const workflowApprovals = pgTable(
  "workflow_approvals",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => workflowInstances.id),
    stageId: text("stage_id").notNull(),
    approverId: text("approver_id").notNull(),
    status: text("status")
      .notNull()
      .default("pending"),
    decisionReason: text("decision_reason"),
    autoApprovedByRuleId: text("auto_approved_by_rule_id").references(
      () => businessRules.id
    ),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    decidedAt: bigint("decided_at", { mode: "number" }),
  },
  (table) => [
    index("idx_wf_approvals_instance").on(table.instanceId),
    index("idx_wf_approvals_approver").on(table.approverId),
    index("idx_wf_approvals_status").on(table.status),
  ]
);

// ============================================================
// integrations
// ============================================================
export const integrations = pgTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    type: text("type").notNull(),
    config: jsonb("config").notNull(),
    status: text("status")
      .notNull()
      .default("active"),
    lastUsedAt: bigint("last_used_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_integrations_tenant").on(table.tenantId),
    index("idx_integrations_type").on(table.type),
  ]
);

// ============================================================
// conversation_sessions
// ============================================================
export const conversationSessions = pgTable(
  "conversation_sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    channel: text("channel").notNull(),
    channelUserId: text("channel_user_id").notNull(),
    userName: text("user_name"),
    userRole: text("user_role"),
    activeInstanceId: text("active_instance_id").references(
      () => workflowInstances.id
    ),
    state: jsonb("state").notNull().default({}),
    lastMessageAt: bigint("last_message_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_conv_sessions_tenant").on(table.tenantId),
    index("idx_conv_sessions_channel_user").on(
      table.channel,
      table.channelUserId
    ),
    index("idx_conv_sessions_active_instance").on(table.activeInstanceId),
  ]
);
