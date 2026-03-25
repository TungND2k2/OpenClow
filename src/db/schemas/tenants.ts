import {
  pgTable,
  text,
  bigint,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ============================================================
// super_admins — owner of the entire system
// ============================================================
export const superAdmins = pgTable(
  "super_admins",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull().default("telegram"),
    channelUserId: text("channel_user_id").notNull(),
    displayName: text("display_name"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_super_admins_channel_user").on(table.channel, table.channelUserId),
  ]
);

// ============================================================
// tenants — each tenant = 1 bot
// ============================================================
export const tenants = pgTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    botToken: text("bot_token"),              // Telegram bot token
    botUsername: text("bot_username"),         // @milo_suport_bot
    botStatus: text("bot_status").notNull().default("active"), // active | stopped
    config: jsonb("config").notNull().default({}),
    aiConfig: jsonb("ai_config").notNull().default({}),
    instructions: text("instructions").notNull().default(""), // Bot self-updating guide
    status: text("status")
      .notNull()
      .default("active"),
    createdByUserId: text("created_by_user_id"),
    createdByName: text("created_by_name"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_tenants_status").on(table.status)]
);

// ============================================================
// tenant_users — maps external users (telegram, etc.) to roles
// ============================================================
export const tenantUsers = pgTable(
  "tenant_users",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    channel: text("channel").notNull(), // "telegram", "web", "slack"
    channelUserId: text("channel_user_id").notNull(), // telegram user ID, etc.
    displayName: text("display_name"),
    role: text("role")
      .notNull()
      .default("user"),
    permissions: jsonb("permissions").default([]), // granted permissions: ["form_templates:CRU", "collection_rows:CRUD"]
    reportsTo: text("reports_to"), // channel_user_id of direct manager (1 person)
    metadata: jsonb("metadata").default({}), // phone, position, etc.
    isActive: boolean("is_active").notNull().default(true),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_tenant_users_channel_user").on(
      table.tenantId,
      table.channel,
      table.channelUserId
    ),
    index("idx_tenant_users_tenant").on(table.tenantId),
    index("idx_tenant_users_role").on(table.role),
  ]
);
