/**
 * Permission Service — dynamic role-based access control.
 *
 * Admin: full access
 * Manager: default CRU on most resources, xin admin cho thêm
 * Staff/Sales: default CR on rows, xin manager/admin cho thêm
 * User: default R
 */

import { eq, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { tenantUsers, permissionRequests, auditLogs } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";

// ── Default permissions per role ─────────────────────────────

const DEFAULT_PERMISSIONS: Record<string, Record<string, string>> = {
  admin: {}, // admin = full, no need to list
  manager: {
    form_templates: "CRUD",
    workflow_templates: "CRUD",
    business_rules: "CRU",
    collections: "CRUD",
    collection_rows: "CRUD",
    knowledge_entries: "CR",
    tenant_users: "R",
  },
  sales: {
    form_templates: "R",
    collections: "R",
    collection_rows: "CRU",
    knowledge_entries: "R",
  },
  staff: {
    form_templates: "R",
    collections: "R",
    collection_rows: "CRU",
    knowledge_entries: "R",
  },
  user: {
    collection_rows: "R",
    knowledge_entries: "R",
  },
};

type Action = "C" | "R" | "U" | "D";

const ACTION_MAP: Record<string, Action> = {
  create: "C", list: "R", get: "R", update: "U", delete: "D",
};

// ── Check permission ─────────────────────────────────────────

export interface PermCheckResult {
  allowed: boolean;
  reason?: string;
  needsApproval?: {
    approverId: string;
    approverName: string;
    resource: string;
    action: string;
  };
}

export async function checkPermission(
  tenantId: string,
  userId: string,
  userRole: string,
  resource: string,
  action: string,
): Promise<PermCheckResult> {
  // Admin = full access
  if (userRole === "admin") return { allowed: true };

  const actionCode = ACTION_MAP[action] ?? action.charAt(0).toUpperCase() as Action;

  // Check default permissions
  const defaults = DEFAULT_PERMISSIONS[userRole] ?? {};
  const defaultAccess = defaults[resource] ?? "";
  if (defaultAccess.includes(actionCode)) return { allowed: true };

  // Check extra permissions granted by admin/manager
  const db = getDb();
  const user = (await db.select({ permissions: tenantUsers.permissions, reportsTo: tenantUsers.reportsTo })
    .from(tenantUsers)
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.channel, "telegram"),
      eq(tenantUsers.channelUserId, userId),
    )).limit(1))[0];

  if (user) {
    const extra = (user.permissions as string[]) ?? [];
    // Format: "form_templates:CRUD"
    const granted = extra.find(p => p.startsWith(`${resource}:`));
    if (granted) {
      const access = granted.split(":")[1] ?? "";
      if (access.includes(actionCode)) return { allowed: true };
    }
  }

  // Not allowed — find who to ask
  const reportsTo = user?.reportsTo;
  if (reportsTo) {
    const manager = (await db.select({ displayName: tenantUsers.displayName })
      .from(tenantUsers)
      .where(and(
        eq(tenantUsers.tenantId, tenantId),
        eq(tenantUsers.channel, "telegram"),
        eq(tenantUsers.channelUserId, reportsTo),
      )).limit(1))[0];

    return {
      allowed: false,
      reason: `Bạn chưa có quyền ${actionCode} trên ${resource}`,
      needsApproval: {
        approverId: reportsTo,
        approverName: manager?.displayName ?? reportsTo,
        resource,
        action: actionCode,
      },
    };
  }

  // No reports_to → find any admin
  const admin = (await db.select({ channelUserId: tenantUsers.channelUserId, displayName: tenantUsers.displayName })
    .from(tenantUsers)
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.role, "admin"),
      eq(tenantUsers.isActive, true),
    )).limit(1))[0];

  return {
    allowed: false,
    reason: `Bạn chưa có quyền ${actionCode} trên ${resource}`,
    needsApproval: admin ? {
      approverId: admin.channelUserId,
      approverName: admin.displayName ?? "Admin",
      resource,
      action: actionCode,
    } : undefined,
  };
}

// ── Create permission request ────────────────────────────────

export async function createPermissionRequest(input: {
  tenantId: string;
  requesterId: string;
  requesterName: string;
  approverId: string;
  approverName: string;
  resource: string;
  requestedAccess: string;
  reason?: string;
}): Promise<string> {
  const db = getDb();
  const id = newId();
  await db.insert(permissionRequests).values({
    id,
    tenantId: input.tenantId,
    requesterId: input.requesterId,
    requesterName: input.requesterName,
    approverId: input.approverId,
    approverName: input.approverName,
    resource: input.resource,
    requestedAccess: input.requestedAccess,
    reason: input.reason,
    status: "pending",
    createdAt: nowMs(),
  });
  return id;
}

// ── Grant permission ─────────────────────────────────────────

export async function grantPermission(
  tenantId: string,
  targetUserId: string,
  resource: string,
  access: string, // "CRUD", "CRU", "CR", "R"
): Promise<void> {
  const db = getDb();
  const user = (await db.select({ id: tenantUsers.id, permissions: tenantUsers.permissions })
    .from(tenantUsers)
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.channel, "telegram"),
      eq(tenantUsers.channelUserId, targetUserId),
    )).limit(1))[0];

  if (!user) throw new Error(`User ${targetUserId} not found`);

  const perms = (user.permissions as string[]) ?? [];
  // Remove old permission for same resource
  const filtered = perms.filter(p => !p.startsWith(`${resource}:`));
  filtered.push(`${resource}:${access}`);

  await db.update(tenantUsers).set({
    permissions: filtered,
    updatedAt: nowMs(),
  }).where(eq(tenantUsers.id, user.id));
}

// ── Revoke permission ────────────────────────────────────────

export async function revokePermission(
  tenantId: string,
  targetUserId: string,
  resource: string,
): Promise<void> {
  const db = getDb();
  const user = (await db.select({ id: tenantUsers.id, permissions: tenantUsers.permissions })
    .from(tenantUsers)
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.channel, "telegram"),
      eq(tenantUsers.channelUserId, targetUserId),
    )).limit(1))[0];

  if (!user) throw new Error(`User ${targetUserId} not found`);

  const perms = (user.permissions as string[]) ?? [];
  const filtered = perms.filter(p => !p.startsWith(`${resource}:`));

  await db.update(tenantUsers).set({
    permissions: filtered,
    updatedAt: nowMs(),
  }).where(eq(tenantUsers.id, user.id));
}

// ── Resolve permission request ───────────────────────────────

export async function resolvePermissionRequest(
  requestId: string,
  status: "approved" | "rejected",
  grantedAccess?: string,
): Promise<void> {
  const db = getDb();
  const req = (await db.select().from(permissionRequests).where(eq(permissionRequests.id, requestId)).limit(1))[0];
  if (!req) throw new Error(`Request ${requestId} not found`);

  await db.update(permissionRequests).set({
    status,
    grantedAccess: grantedAccess ?? (status === "approved" ? req.requestedAccess : null),
    resolvedAt: nowMs(),
  }).where(eq(permissionRequests.id, requestId));

  // If approved, grant the permission
  if (status === "approved") {
    await grantPermission(req.tenantId, req.requesterId, req.resource, grantedAccess ?? req.requestedAccess);
  }
}

// ── Get pending requests for an approver ─────────────────────

export async function getPendingRequests(approverId: string): Promise<any[]> {
  const db = getDb();
  return await db.select().from(permissionRequests)
    .where(and(
      eq(permissionRequests.approverId, approverId),
      eq(permissionRequests.status, "pending"),
    ));
}

// ── Audit log ────────────────────────────────────────────────

export async function logAudit(input: {
  tenantId: string;
  userId: string;
  userName?: string;
  userRole?: string;
  action: string;
  resourceTable: string;
  resourceId?: string;
  beforeData?: unknown;
  afterData?: unknown;
  permissionRequestId?: string;
}): Promise<void> {
  const db = getDb();
  await db.insert(auditLogs).values({
    id: newId(),
    tenantId: input.tenantId,
    userId: input.userId,
    userName: input.userName,
    userRole: input.userRole,
    action: input.action,
    resourceTable: input.resourceTable,
    resourceId: input.resourceId,
    beforeData: input.beforeData ? JSON.stringify(input.beforeData) : null,
    afterData: input.afterData ? JSON.stringify(input.afterData) : null,
    permissionRequestId: input.permissionRequestId,
    createdAt: nowMs(),
  });
}
