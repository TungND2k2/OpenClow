/**
 * Resource Cache — per-tenant summary of all resources.
 *
 * Build once on startup + refresh when data changes.
 * Commander reads cache instead of querying DB every request.
 *
 * Cache lives in memory (Map) — rebuilt from DB on restart.
 * ~100 chars per tenant injected into prompt.
 */

import { getDb } from "../../db/connection.js";
import {
  formTemplates, workflowTemplates, businessRules,
  collections, tenants,
} from "../../db/schema.js";
import { eq, and, sql, count } from "drizzle-orm";

export interface ResourceSummary {
  tenantId: string;
  forms: { name: string; fieldCount: number }[];
  collections: { name: string; slug: string; rowCount: number }[];
  workflows: { name: string; description: string | null }[];
  rulesCount: number;
  filesCount: number;
  workersCount: number;
  updatedAt: number;
}

// In-memory cache — per tenant
const _cache = new Map<string, ResourceSummary>();

/**
 * Build resource summary for a tenant from DB.
 */
export async function buildResourceSummary(tenantId: string): Promise<ResourceSummary> {
  const db = getDb();

  // Forms
  const forms = await db.select({
    name: formTemplates.name,
    schema: formTemplates.schema,
  }).from(formTemplates)
    .where(and(eq(formTemplates.tenantId, tenantId), eq(formTemplates.status, "active")));

  const formSummary = forms.map(f => {
    const schema = typeof f.schema === "string" ? JSON.parse(f.schema) : f.schema;
    return { name: f.name, fieldCount: (schema?.fields ?? []).length };
  });

  // Collections + row counts
  const cols = await db.select({
    name: collections.name,
    slug: collections.slug,
    id: collections.id,
  }).from(collections)
    .where(and(eq(collections.tenantId, tenantId), eq(collections.isActive, true)));

  const colSummary: { name: string; slug: string; rowCount: number }[] = [];
  for (const c of cols) {
    const [{ count: rc }] = await db.select({ count: sql<number>`count(*)` })
      .from(sql`collection_rows`)
      .where(sql`collection_id = ${c.id}`);
    colSummary.push({ name: c.name, slug: c.slug, rowCount: Number(rc) });
  }

  // Workflows
  const workflows = await db.select({
    name: workflowTemplates.name,
    description: workflowTemplates.description,
  }).from(workflowTemplates)
    .where(and(eq(workflowTemplates.tenantId, tenantId), eq(workflowTemplates.status, "active")));

  // Rules count
  const [{ count: rulesCount }] = await db.select({ count: sql<number>`count(*)` })
    .from(businessRules)
    .where(and(eq(businessRules.tenantId, tenantId), eq(businessRules.status, "active")));

  // Files count
  const [{ count: filesCount }] = await db.select({ count: sql<number>`count(*)` })
    .from(sql`files`)
    .where(sql`tenant_id = ${tenantId}`);

  // Workers count
  const [{ count: workersCount }] = await db.select({ count: sql<number>`count(*)` })
    .from(sql`agent_templates`)
    .where(sql`(tenant_id = ${tenantId} OR tenant_id IS NULL) AND status = 'active' AND role != 'commander'`);

  const summary: ResourceSummary = {
    tenantId,
    forms: formSummary,
    collections: colSummary,
    workflows: workflows.map(w => ({ name: w.name, description: w.description })),
    rulesCount: Number(rulesCount),
    filesCount: Number(filesCount),
    workersCount: Number(workersCount),
    updatedAt: Date.now(),
  };

  _cache.set(tenantId, summary);
  console.error(`[Cache] Built resource summary for ${tenantId}: ${formSummary.length} forms, ${colSummary.length} collections, ${workflows.length} workflows, ${rulesCount} rules, ${filesCount} files, ${workersCount} workers`);

  return summary;
}

/**
 * Get cached summary — returns from memory, no DB query.
 */
export function getResourceSummary(tenantId: string): ResourceSummary | null {
  return _cache.get(tenantId) ?? null;
}

/**
 * Invalidate cache for a tenant — will rebuild on next request.
 */
export function invalidateCache(tenantId: string): void {
  _cache.delete(tenantId);
}

/**
 * Build cache for ALL active tenants — call on startup.
 */
export async function initResourceCache(): Promise<void> {
  const db = getDb();
  const allTenants = await db.select({ id: tenants.id, name: tenants.name })
    .from(tenants).where(eq(tenants.status, "active"));

  for (const t of allTenants) {
    await buildResourceSummary(t.id);
  }
  console.error(`[Cache] Initialized for ${allTenants.length} tenants`);
}

/**
 * Format summary as short text for prompt injection (~100-200 chars).
 */
export function formatSummaryForPrompt(summary: ResourceSummary): string {
  const parts: string[] = [];

  if (summary.forms.length > 0) {
    parts.push(`Forms: ${summary.forms.map(f => `"${f.name}" (${f.fieldCount} fields)`).join(", ")}`);
  }
  if (summary.collections.length > 0) {
    parts.push(`Bảng dữ liệu: ${summary.collections.map(c => `"${c.name}" (${c.rowCount} rows)`).join(", ")}`);
  }
  if (summary.workflows.length > 0) {
    parts.push(`Workflows: ${summary.workflows.map(w => `"${w.name}"`).join(", ")}`);
  }
  if (summary.rulesCount > 0) parts.push(`${summary.rulesCount} business rules`);
  if (summary.filesCount > 0) parts.push(`${summary.filesCount} files đã upload`);
  if (summary.workersCount > 0) parts.push(`${summary.workersCount} workers`);

  if (parts.length === 0) return "";

  return `\n\nHỆ THỐNG HIỆN CÓ:\n${parts.join("\n")}\n→ Dùng tools để truy vấn chi tiết. Khi user nhắc đến resource có sẵn → gọi tool tương ứng, KHÔNG hỏi lại.`;
}
