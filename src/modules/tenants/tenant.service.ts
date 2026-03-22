import { eq } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { tenants } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";

export interface TenantRecord {
  id: string;
  name: string;
  config: Record<string, unknown>;
  aiConfig: Record<string, unknown>;
  status: "active" | "suspended" | "archived";
  createdAt: number;
  updatedAt: number;
}

export async function createTenant(input: {
  name: string;
  config?: Record<string, unknown>;
  aiConfig?: Record<string, unknown>;
}): Promise<TenantRecord> {
  const db = getDb();
  const now = nowMs();
  const id = newId();
  await db.insert(tenants).values({
    id,
    name: input.name,
    config: JSON.stringify(input.config ?? {}),
    aiConfig: JSON.stringify(input.aiConfig ?? {}),
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return { id, name: input.name, config: input.config ?? {}, aiConfig: input.aiConfig ?? {}, status: "active", createdAt: now, updatedAt: now };
}

export async function getTenant(tenantId: string): Promise<TenantRecord | null> {
  const db = getDb();
  const row = (await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1))[0];
  if (!row) return null;
  return { ...row, config: row.config as any, aiConfig: row.aiConfig as any, status: row.status as any };
}

export async function updateTenant(tenantId: string, updates: Partial<Pick<TenantRecord, "config" | "aiConfig" | "status">>): Promise<void> {
  const db = getDb();
  const set: Record<string, any> = { updatedAt: nowMs() };
  if (updates.config) set.config = JSON.stringify(updates.config);
  if (updates.aiConfig) set.aiConfig = JSON.stringify(updates.aiConfig);
  if (updates.status) set.status = updates.status;
  await db.update(tenants).set(set).where(eq(tenants.id, tenantId));
}
