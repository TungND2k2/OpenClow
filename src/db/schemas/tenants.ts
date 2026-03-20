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
// tenants
// ============================================================
export const tenants = pgTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    config: jsonb("config").notNull().default({}),
    aiConfig: jsonb("ai_config").notNull().default({}),
    status: text("status")
      .notNull()
      .default("active"),
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
    permissions: jsonb("permissions").default([]), // granular permissions
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
