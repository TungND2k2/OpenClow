import {
  pgTable,
  text,
  bigint,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

// ============================================================
// permission_requests — staff/manager xin quyền từ cấp trên
// ============================================================
export const permissionRequests = pgTable(
  "permission_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    requesterId: text("requester_id").notNull(),       // channel_user_id
    requesterName: text("requester_name"),
    approverId: text("approver_id").notNull(),          // channel_user_id (1 người)
    approverName: text("approver_name"),
    resource: text("resource").notNull(),                // "form_templates", "collection_rows"
    requestedAccess: text("requested_access").notNull(), // "CRUD", "CRU", "CR", "R"
    reason: text("reason"),                              // lý do xin quyền
    status: text("status").notNull().default("pending"), // pending | approved | rejected
    grantedAccess: text("granted_access"),               // access thực tế được cấp (có thể khác requested)
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
  },
  (table) => [
    index("idx_perm_req_tenant").on(table.tenantId),
    index("idx_perm_req_approver").on(table.approverId, table.status),
    index("idx_perm_req_requester").on(table.requesterId),
  ]
);

// ============================================================
// audit_logs — mọi thao tác qua db_query đều lưu
// ============================================================
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    userId: text("user_id").notNull(),
    userName: text("user_name"),
    userRole: text("user_role"),
    action: text("action").notNull(),            // create | read | update | delete
    resourceTable: text("resource_table").notNull(),
    resourceId: text("resource_id"),
    beforeData: jsonb("before_data"),
    afterData: jsonb("after_data"),
    permissionRequestId: text("permission_request_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_audit_tenant").on(table.tenantId),
    index("idx_audit_user").on(table.userId),
    index("idx_audit_table").on(table.resourceTable),
  ]
);
