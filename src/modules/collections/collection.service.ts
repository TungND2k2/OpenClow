/**
 * Collection Service — CRUD for dynamic collections (admin-defined "tables").
 */

import { getDb } from "../../db/connection.js";
import { collections, collectionRows } from "../../db/schemas/collections.js";
import { eq, and, sql } from "drizzle-orm";
import { newId } from "../../utils/id.js";

// ── Types ────────────────────────────────────────────────────

export interface CollectionField {
  name: string;       // "mã_đơn", "loại_vải"
  type: "text" | "number" | "date" | "url" | "boolean";
  required?: boolean;
}

// ── Create Collection ────────────────────────────────────────

export async function createCollection(input: {
  tenantId: string;
  name: string;
  description?: string;
  fields: CollectionField[];
  createdBy?: string;
}) {
  const db = getDb();
  const id = newId();
  const slug = input.name.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const now = Date.now();

  await db.insert(collections).values({
    id, tenantId: input.tenantId, name: input.name, slug,
    description: input.description ?? null,
    fields: input.fields,
    createdBy: input.createdBy ?? null,
    isActive: true, createdAt: now, updatedAt: now,
  });

  return { id, name: input.name, slug, fields: input.fields };
}

// ── List Collections ─────────────────────────────────────────

export async function listCollections(tenantId: string) {
  const db = getDb();
  return db.select({
    id: collections.id, name: collections.name, slug: collections.slug,
    description: collections.description, fields: collections.fields,
  }).from(collections).where(
    and(eq(collections.tenantId, tenantId), eq(collections.isActive, true))
  );
}

// ── Get Collection ───────────────────────────────────────────

export async function getCollection(id: string) {
  const db = getDb();
  return (await db.select().from(collections).where(eq(collections.id, id)).limit(1))[0] ?? null;
}

// ── Find Collection by name/slug ─────────────────────────────

export async function findCollection(tenantId: string, nameOrSlug: string) {
  const db = getDb();
  const all = await db.select().from(collections).where(
    and(eq(collections.tenantId, tenantId), eq(collections.isActive, true))
  );
  const lower = nameOrSlug.toLowerCase();
  return all.find(c =>
    c.name.toLowerCase() === lower ||
    c.slug === lower ||
    c.name.toLowerCase().includes(lower) ||
    c.slug.includes(lower)
  ) ?? null;
}

// ── Insert Row ───────────────────────────────────────────────

export async function insertRow(input: {
  collectionId: string;
  data: Record<string, unknown>;
  createdBy?: string;
}) {
  const db = getDb();
  const id = newId();
  const now = Date.now();

  await db.insert(collectionRows).values({
    id, collectionId: input.collectionId,
    data: input.data,
    createdBy: input.createdBy ?? null,
    createdAt: now, updatedAt: now,
  });

  return { id, ...input.data };
}

// ── List Rows (with pagination + smart search) ──────────────

export async function listRows(
  collectionId: string,
  limit = 20,
  offset = 0,
  keyword?: string,
) {
  const db = getDb();

  // If keyword → filter in PostgreSQL using JSON text search
  if (keyword) {
    const rows = await db.select({
      id: collectionRows.id, data: collectionRows.data, createdAt: collectionRows.createdAt,
    }).from(collectionRows)
      .where(and(
        eq(collectionRows.collectionId, collectionId),
        sql`${collectionRows.data}::text ILIKE ${'%' + keyword + '%'}`,
      ))
      .orderBy(sql`${collectionRows.createdAt} DESC`)
      .limit(limit).offset(offset);

    // Get total count for pagination
    const countResult = await db.select({ count: sql<number>`count(*)` })
      .from(collectionRows)
      .where(and(
        eq(collectionRows.collectionId, collectionId),
        sql`${collectionRows.data}::text ILIKE ${'%' + keyword + '%'}`,
      ));

    const total = Number(countResult[0]?.count ?? 0);
    return { rows, total, hasMore: offset + limit < total };
  }

  // No keyword → simple pagination
  const rows = await db.select({
    id: collectionRows.id, data: collectionRows.data, createdAt: collectionRows.createdAt,
  }).from(collectionRows)
    .where(eq(collectionRows.collectionId, collectionId))
    .orderBy(sql`${collectionRows.createdAt} DESC`)
    .limit(limit).offset(offset);

  const countResult = await db.select({ count: sql<number>`count(*)` })
    .from(collectionRows)
    .where(eq(collectionRows.collectionId, collectionId));

  const total = Number(countResult[0]?.count ?? 0);
  return { rows, total, hasMore: offset + limit < total };
}

// ── Update Row ───────────────────────────────────────────────

export async function updateRow(rowId: string, data: Record<string, unknown>) {
  const db = getDb();
  const existing = (await db.select().from(collectionRows).where(eq(collectionRows.id, rowId)).limit(1))[0];
  if (!existing) return null;

  const merged = { ...(existing.data as Record<string, unknown>), ...data };
  await db.update(collectionRows).set({ data: merged, updatedAt: Date.now() }).where(eq(collectionRows.id, rowId));
  return { id: rowId, data: merged };
}

// ── Delete Row ───────────────────────────────────────────────

export async function deleteRow(rowId: string) {
  const db = getDb();
  const result = await db.delete(collectionRows).where(eq(collectionRows.id, rowId)).returning({ id: collectionRows.id });
  return result.length > 0;
}

// ── Search All Rows (across all collections — SQL-level filter) ──

export async function searchAllRows(tenantId: string, keyword?: string, limit = 20) {
  const db = getDb();

  // Get all active collections for tenant
  const cols = await db.select({ id: collections.id, name: collections.name })
    .from(collections)
    .where(and(eq(collections.tenantId, tenantId), eq(collections.isActive, true)));

  if (cols.length === 0) return [];

  const results: { collection: string; id: string; data: unknown; createdAt: number }[] = [];

  for (const col of cols) {
    // Filter in PostgreSQL, not in memory
    const whereConditions = keyword
      ? and(
          eq(collectionRows.collectionId, col.id),
          sql`${collectionRows.data}::text ILIKE ${'%' + keyword + '%'}`,
        )
      : eq(collectionRows.collectionId, col.id);

    const rows = await db.select({
      id: collectionRows.id, data: collectionRows.data, createdAt: collectionRows.createdAt,
    }).from(collectionRows)
      .where(whereConditions)
      .orderBy(sql`${collectionRows.createdAt} DESC`)
      .limit(limit);

    for (const row of rows) {
      results.push({ collection: col.name, id: row.id, data: row.data, createdAt: row.createdAt });
    }
  }

  return results;
}

// ── Count Rows (for summary when too many) ──────────────────

export async function countRows(collectionId: string): Promise<number> {
  const db = getDb();
  const result = await db.select({ count: sql<number>`count(*)` })
    .from(collectionRows)
    .where(eq(collectionRows.collectionId, collectionId));
  return Number(result[0]?.count ?? 0);
}
