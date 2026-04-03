/**
 * Data Injector — pre-fetches collection data into LLM context.
 *
 * Thay vì để LLM tự gọi list_rows để đọc data, module này:
 *   1. Detect collection nào liên quan đến message của user
 *   2. Fetch rows thật từ DB
 *   3. Trả về context string đã format → inject vào system prompt
 *
 * LLM nhận được data sẵn → chỉ cần tools cho WRITE (add/update/delete).
 */

import { getDb } from "../../db/connection.js";
import { collections, collectionRows } from "../../db/schemas/collections.js";
import { eq, and, sql } from "drizzle-orm";
import type { ResourceSummary } from "../cache/resource-cache.js";

const MAX_COLLECTIONS_PER_REQUEST = 3;
const MAX_ROWS_PER_COLLECTION = 30;
const MAX_TOTAL_CHARS = 5000;
const MAX_CELL_CHARS = 120;
const MAX_FIELDS_SHOWN = 8;

// ── Normalization ────────────────────────────────────────────

/**
 * Normalize Vietnamese text for keyword matching:
 * bỏ dấu, lowercase, strip ký tự đặc biệt.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Relevance scoring ────────────────────────────────────────

/**
 * Score how relevant a collection is to the user message.
 * Returns 0 if not relevant, >0 if relevant (higher = more relevant).
 */
function scoreRelevance(
  normalizedMessage: string,
  originalMessage: string,
  colName: string,
  colSlug: string,
): number {
  const normName = normalize(colName);
  const normSlug = colSlug.replace(/-/g, " ");

  // Exact full name match (highest priority)
  if (normalizedMessage.includes(normName)) return 10;

  // Slug match
  if (normalizedMessage.includes(normSlug)) return 8;

  // Original name in original message (tiếng Việt có dấu)
  if (originalMessage.toLowerCase().includes(colName.toLowerCase())) return 7;

  // All significant words of the collection name appear in message
  const words = normName.split(" ").filter(w => w.length > 2);
  if (words.length === 0) return 0;

  const matchedWords = words.filter(w => normalizedMessage.includes(w));
  const ratio = matchedWords.length / words.length;

  if (ratio === 1) return 6;     // all words matched
  if (ratio >= 0.6) return 3;   // majority matched
  if (ratio >= 0.3) return 1;   // partial match

  return 0;
}

// ── Row formatting ───────────────────────────────────────────

function truncateCell(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = typeof val === "object" ? JSON.stringify(val) : String(val);
  return s.length > MAX_CELL_CHARS ? s.substring(0, MAX_CELL_CHARS) + "…" : s;
}

function formatCollectionData(
  colName: string,
  colId: string,
  fields: { name: string; type: string }[],
  rows: { id: string; data: unknown }[],
  totalCount: number,
): string {
  const shownFields = fields.slice(0, MAX_FIELDS_SHOWN);
  const fieldNames = shownFields.length > 0
    ? shownFields.map(f => f.name)
    : (rows[0]?.data ? Object.keys(rows[0].data as object).slice(0, MAX_FIELDS_SHOWN) : []);

  const shown = Math.min(rows.length, MAX_ROWS_PER_COLLECTION);
  const countNote = totalCount > shown ? ` (${shown}/${totalCount} dòng mới nhất)` : ` (${shown} dòng)`;
  const hiddenFieldsNote = fields.length > MAX_FIELDS_SHOWN
    ? ` [+${fields.length - MAX_FIELDS_SHOWN} cột ẩn]`
    : "";

  if (rows.length === 0) {
    return `📋 ${colName} [id:${colId}]${countNote}: Chưa có dữ liệu`;
  }

  const header = ["id", ...fieldNames].join(" | ");
  const sep = ["---", ...fieldNames.map(() => "---")].join(" | ");
  const dataRows = rows.slice(0, shown).map(r => {
    const d = r.data as Record<string, unknown>;
    return [r.id.slice(-6), ...fieldNames.map(f => truncateCell(d[f]))].join(" | ");
  });

  return `📋 ${colName} [id:${colId}]${countNote}${hiddenFieldsNote}:\n${header}\n${sep}\n${dataRows.join("\n")}`;
}

// ── Main export ──────────────────────────────────────────────

/**
 * Detect relevant collections from user message, fetch their rows,
 * and return a formatted string ready to inject into system prompt.
 *
 * Returns "" if no collections are relevant or no data exists.
 */
export async function buildDataContext(
  tenantId: string,
  userMessage: string,
  summary: ResourceSummary | null,
): Promise<string> {
  if (!summary || summary.collections.length === 0) return "";

  const normalizedMsg = normalize(userMessage);

  // Score all collections
  const scored = summary.collections
    .map(c => ({
      name: c.name,
      slug: c.slug,
      rowCount: c.rowCount,
      score: scoreRelevance(normalizedMsg, userMessage, c.name, c.slug),
    }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_COLLECTIONS_PER_REQUEST);

  if (scored.length === 0) return "";

  const db = getDb();
  const parts: string[] = [];
  let totalChars = 0;

  for (const col of scored) {
    if (totalChars >= MAX_TOTAL_CHARS) break;

    // Look up collection record by slug + tenantId
    const colRecord = (await db
      .select({ id: collections.id, fields: collections.fields })
      .from(collections)
      .where(and(
        eq(collections.slug, col.slug),
        eq(collections.tenantId, tenantId),
        eq(collections.isActive, true),
      ))
      .limit(1)
    )[0];

    if (!colRecord) continue;

    const fields = (colRecord.fields as { name: string; type: string }[]) ?? [];

    // Total count
    const [{ count: totalCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(collectionRows)
      .where(eq(collectionRows.collectionId, colRecord.id));

    // Fetch latest rows
    const rows = await db
      .select({ id: collectionRows.id, data: collectionRows.data })
      .from(collectionRows)
      .where(eq(collectionRows.collectionId, colRecord.id))
      .orderBy(sql`${collectionRows.createdAt} DESC`)
      .limit(MAX_ROWS_PER_COLLECTION);

    const block = formatCollectionData(col.name, colRecord.id, fields, rows, Number(totalCount));
    totalChars += block.length;
    parts.push(block);

    console.error(`[DataInjector] ${col.name}: ${rows.length} rows injected (score=${col.score})`);
  }

  if (parts.length === 0) return "";

  return `\n\n━━ DỮ LIỆU ĐÃ TẢI SẴN ━━
${parts.join("\n\n")}
━━━━━━━━━━━━━━━━━━━━━━━━
→ Dùng "id" ở cột đầu (6 ký tự cuối của row id) để update/delete. Tools list_rows/search_all CHỈ gọi khi cần thêm data ngoài context này.`;
}
