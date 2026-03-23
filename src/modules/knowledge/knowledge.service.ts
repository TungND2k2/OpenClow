import { eq, and, sql, desc } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { knowledgeEntries, knowledgeApplications } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";
import { computeMatchScore, computeEffectiveRelevance } from "./knowledge.scorer.js";
import type { KnowledgeEntry, KnowledgeType, RetrievedKnowledge } from "./knowledge.types.js";

function toEntry(row: any): KnowledgeEntry {
  return {
    ...row,
    tags: row.tags ?? [],
    type: row.type as KnowledgeType,
  };
}

/**
 * Store a knowledge entry.
 */
export async function storeKnowledge(input: {
  type: KnowledgeType;
  title: string;
  content: string;
  domain: string;
  tags: string[];
  scope?: string;
  sourceTaskId?: string;
  sourceAgentId: string;
  outcome?: "success" | "failure" | "neutral";
  confidence?: number;
  contextSnapshot?: Record<string, unknown>;
}): Promise<KnowledgeEntry> {
  const db = getDb();
  const now = nowMs();
  const id = newId();

  const record = {
    id,
    type: input.type,
    title: input.title,
    content: input.content,
    domain: input.domain,
    tags: JSON.stringify(input.tags),
    sourceTaskId: input.sourceTaskId ?? null,
    sourceAgentId: input.sourceAgentId,
    scope: input.scope ?? "global",
    relevanceScore: 0.5,
    confidence: input.confidence ?? 0.5,
    usageCount: 0,
    upvotes: 0,
    downvotes: 0,
    outcome: input.outcome ?? null,
    contextSnapshot: input.contextSnapshot ? JSON.stringify(input.contextSnapshot) : null,
    supersededById: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(knowledgeEntries).values(record);

  return { ...record, tags: input.tags, contextSnapshot: input.contextSnapshot ?? null } as KnowledgeEntry;
}

/**
 * Retrieve relevant knowledge for a task context.
 */
export async function retrieveKnowledge(context: {
  tags: string[];
  capabilities: string[];
  domain: string;
  scope?: string[];
  limit?: number;
}): Promise<RetrievedKnowledge[]> {
  const db = getDb();

  // Get candidate entries
  const conditions: any[] = [
    sql`${knowledgeEntries.supersededById} IS NULL`,
    sql`(${knowledgeEntries.expiresAt} IS NULL OR ${knowledgeEntries.expiresAt} > ${Date.now()})`,
  ];

  if (context.scope && context.scope.length > 0) {
    const scopeConditions = context.scope.map(
      (s) => sql`${knowledgeEntries.scope} = ${s}`
    );
    conditions.push(sql`(${sql.join(scopeConditions, sql` OR `)})`);
  }

  const candidates = await db
    .select()
    .from(knowledgeEntries)
    .where(and(...conditions))
    .limit(200);

  // Score and rank
  const scored: RetrievedKnowledge[] = candidates.map((row) => {
    const entry = toEntry(row);
    const tags = typeof row.tags === "string" ? JSON.parse(row.tags as string) : (row.tags ?? []);
    const matchScore = computeMatchScore(
      { ...row, tags, domain: row.domain },
      context
    );
    const effectiveRelevance = computeEffectiveRelevance(row);
    return { ...entry, tags, matchScore, effectiveRelevance };
  });

  scored.sort((a, b) => b.matchScore - a.matchScore);
  return scored.slice(0, context.limit ?? 5);
}

/**
 * Merge or create a rule by intent (tool combination).
 * Same tools = same intent → merge keywords, bump use_count.
 * Different tools = new intent → create new rule.
 */
export async function mergeOrCreateRule(input: {
  tools: string[];
  keywords: string[];
  sourceAgentId: string;
  tenantId?: string;
}): Promise<{ action: "merged" | "created" | "skipped"; ruleId: string }> {
  const db = getDb();
  const now = nowMs();

  // Deduplicate + sort tools to create stable intent key
  const intentKey = [...new Set(input.tools)].sort().join(",");
  const newKeywords = input.keywords.filter(k => k.length > 2);

  if (newKeywords.length === 0) {
    return { action: "skipped", ruleId: "" };
  }

  // Find existing rule with same intent (same tool combination)
  const allRules = await db.select().from(knowledgeEntries)
    .where(and(
      eq(knowledgeEntries.type, "best_practice"),
      sql`${knowledgeEntries.supersededById} IS NULL`,
    )).limit(200);

  const existing = allRules.find(r => {
    const content = r.content as string;
    // Extract tools from content: "→ gọi tools: X, Y"
    const toolMatch = content.match(/tools:\s*(.+)/);
    if (!toolMatch) return false;
    const existingTools = toolMatch[1].split(",").map(t => t.trim()).sort().join(",");
    return existingTools === intentKey;
  });

  if (existing) {
    // Merge: add new keywords, bump use_count
    const existingTags = typeof existing.tags === "string"
      ? JSON.parse(existing.tags as string) as string[]
      : (existing.tags as string[]) ?? [];

    const mergedKeywords = [...new Set([...existingTags, ...newKeywords])];

    await db.update(knowledgeEntries).set({
      tags: JSON.stringify(mergedKeywords),
      usageCount: (existing.usageCount ?? 0) + 1,
      updatedAt: now,
    }).where(eq(knowledgeEntries.id, existing.id));

    return { action: "merged", ruleId: existing.id };
  }

  // Create new rule
  const toolNames = [...new Set(input.tools)].join(", ");
  const entry = await storeKnowledge({
    type: "best_practice",
    title: `Intent: ${intentKey}`,
    content: `Khi user hỏi về [${newKeywords.join(", ")}] → gọi tools: ${toolNames}`,
    domain: "general",
    tags: newKeywords,
    sourceAgentId: input.sourceAgentId,
    outcome: "success",
  });

  return { action: "created", ruleId: entry.id };
}

/**
 * Cleanup old, low-usage rules.
 * Call periodically (e.g. daily via orchestrator).
 */
export async function cleanupRules(maxRules = 200, minAge = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const db = getDb();
  const now = nowMs();
  const cutoff = now - minAge;

  // Delete rules: use_count < 2 AND older than minAge
  const deleted = await db.delete(knowledgeEntries).where(and(
    eq(knowledgeEntries.type, "best_practice"),
    sql`${knowledgeEntries.usageCount} < 2`,
    sql`${knowledgeEntries.createdAt} < ${cutoff}`,
  )).returning({ id: knowledgeEntries.id });

  // If still over max, delete lowest use_count
  const remaining = await db.select({ id: knowledgeEntries.id }).from(knowledgeEntries)
    .where(eq(knowledgeEntries.type, "best_practice"));

  if (remaining.length > maxRules) {
    const toDelete = remaining.length - maxRules;
    const lowest = await db.select({ id: knowledgeEntries.id }).from(knowledgeEntries)
      .where(eq(knowledgeEntries.type, "best_practice"))
      .orderBy(sql`${knowledgeEntries.usageCount} ASC, ${knowledgeEntries.createdAt} ASC`)
      .limit(toDelete);

    for (const row of lowest) {
      await db.delete(knowledgeEntries).where(eq(knowledgeEntries.id, row.id));
    }
    return deleted.length + lowest.length;
  }

  return deleted.length;
}

/**
 * Cleanup duplicate rules — group by tools signature, keep highest usage_count.
 * Run on startup.
 */
export async function cleanupDuplicateRules(): Promise<number> {
  const db = getDb();
  const now = nowMs();

  const all = await db.select().from(knowledgeEntries)
    .where(eq(knowledgeEntries.type, "best_practice"));

  // Group by tools signature (extracted from content)
  const groups = new Map<string, typeof all>();
  for (const entry of all) {
    const toolsMatch = entry.content.match(/tools?:\s*(.+)/i);
    if (!toolsMatch) continue;
    const sig = toolsMatch[1].split(",").map(t => t.trim()).sort().join(",");
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig)!.push(entry);
  }

  let deletedCount = 0;
  for (const [, entries] of groups) {
    if (entries.length <= 1) continue;

    // Keep the one with highest usage_count
    entries.sort((a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0));
    const keep = entries[0];
    const duplicates = entries.slice(1);

    // Merge keywords/tags from duplicates into the kept entry
    const allTags = new Set(keep.tags as string[] ?? []);
    for (const dup of duplicates) {
      for (const tag of (dup.tags as string[] ?? [])) allTags.add(tag);
    }

    await db.update(knowledgeEntries)
      .set({ tags: [...allTags], updatedAt: now })
      .where(eq(knowledgeEntries.id, keep.id));

    for (const dup of duplicates) {
      await db.delete(knowledgeEntries).where(eq(knowledgeEntries.id, dup.id));
      deletedCount++;
    }
  }

  if (deletedCount > 0) {
    console.error(`[Knowledge] Cleaned up ${deletedCount} duplicate rules`);
  }
  return deletedCount;
}

// ── Feedback Loop ───────────────────────────────────────────

/**
 * Detect user satisfaction by calling fast-api (LLM-based, no hardcode).
 * Returns: "positive" | "negative" | "neutral"
 */
export async function detectFeedback(input: {
  userMessage: string;
  prevBotResponse: string;
  workerApiBase: string;
  workerApiKey: string;
  workerModel: string;
}): Promise<"positive" | "negative" | "neutral"> {
  if (!input.prevBotResponse || input.prevBotResponse.length < 5) return "neutral";

  try {
    const resp = await fetch(`${input.workerApiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.workerApiKey}`,
      },
      body: JSON.stringify({
        model: input.workerModel,
        messages: [{
          role: "user",
          content: `Bot vừa trả lời: "${input.prevBotResponse.substring(0, 300)}"
User reply: "${input.userMessage.substring(0, 200)}"

User có hài lòng với câu trả lời của bot không?
- "positive" = hài lòng, chấp nhận, dùng kết quả
- "negative" = không vừa ý, sửa, hỏi lại, phàn nàn
- "neutral" = chuyển topic khác, không liên quan

Chỉ trả lời đúng 1 từ: positive hoặc negative hoặc neutral`,
        }],
        max_tokens: 5,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) return "neutral";
    const data = (await resp.json()) as any;
    const answer = (data.choices?.[0]?.message?.content ?? "").trim().toLowerCase();

    if (answer.includes("positive")) return "positive";
    if (answer.includes("negative")) return "negative";
    return "neutral";
  } catch {
    return "neutral";
  }
}

/**
 * Apply feedback to the most recently used knowledge rule.
 * - Negative: decrease use_count, add "rejected" context
 * - Positive: increase use_count, mark as "accepted"
 */
export async function applyFeedback(input: {
  feedback: "positive" | "negative";
  userMessage: string;
  lastToolsCalled: string[];
  lastBotResponse: string;
  reason?: string;
}): Promise<void> {
  const db = getDb();
  const now = nowMs();

  if (input.lastToolsCalled.length === 0) return;

  // Find the rule that was just used (by tools signature)
  const intentKey = [...new Set(input.lastToolsCalled)].sort().join(",");
  const allRules = await db.select().from(knowledgeEntries)
    .where(and(
      eq(knowledgeEntries.type, "best_practice"),
      sql`${knowledgeEntries.supersededById} IS NULL`,
    )).limit(200);

  const rule = allRules.find(r => {
    const content = r.content as string;
    const toolMatch = content.match(/tools:\s*(.+)/);
    if (!toolMatch) return false;
    const existingTools = toolMatch[1].split(",").map(t => t.trim()).sort().join(",");
    return existingTools === intentKey;
  });

  if (!rule) return;

  if (input.feedback === "negative") {
    // Decrease use_count (min 0)
    const newCount = Math.max(0, (rule.usageCount ?? 0) - 1);

    // Append rejection context to content
    const rejectionNote = `\n⚠️ REJECTED: "${input.userMessage}" → user nói "${input.reason ?? "không vừa ý"}"`;
    const updatedContent = (rule.content as string) + rejectionNote;

    await db.update(knowledgeEntries).set({
      usageCount: newCount,
      outcome: "failure",
      content: updatedContent.substring(0, 2000),
      updatedAt: now,
    }).where(eq(knowledgeEntries.id, rule.id));

    console.error(`[Knowledge] ✗ Feedback negative on "${rule.title}" (use_count: ${newCount})`);

  } else if (input.feedback === "positive") {
    await db.update(knowledgeEntries).set({
      usageCount: (rule.usageCount ?? 0) + 1,
      outcome: "success",
      updatedAt: now,
    }).where(eq(knowledgeEntries.id, rule.id));

    console.error(`[Knowledge] ✓ Feedback positive on "${rule.title}" (use_count: ${(rule.usageCount ?? 0) + 1})`);
  }
}

/**
 * Record that knowledge was applied to a task.
 */
export async function recordApplication(input: {
  knowledgeId: string;
  taskId: string;
  agentId: string;
}): Promise<void> {
  const db = getDb();
  const now = nowMs();
  const id = newId();

  await db.insert(knowledgeApplications).values({
    id,
    knowledgeId: input.knowledgeId,
    taskId: input.taskId,
    agentId: input.agentId,
    createdAt: now,
  });

  // Increment usage count
  await db.execute(sql`UPDATE knowledge_entries SET usage_count = usage_count + 1, updated_at = ${now} WHERE id = ${input.knowledgeId}`);
}

/**
 * Extract knowledge from a completed/failed task.
 */
export async function extractFromTask(input: {
  taskId: string;
  taskTitle: string;
  taskTags: string[];
  domain: string;
  agentId: string;
  outcome: "success" | "failure";
  result?: string;
  error?: string;
  retryCount?: number;
  agentPerformanceScore?: number;
}): Promise<KnowledgeEntry | null> {
  let type: KnowledgeType;
  let title: string;
  let content: string;

  if (input.outcome === "success") {
    type = "best_practice";
    title = `Success: ${input.taskTitle}`;
    content = input.result ?? `Task "${input.taskTitle}" completed successfully.`;
    if (input.retryCount && input.retryCount > 0) {
      type = "lesson_learned";
      title = `Learned: ${input.taskTitle} (after ${input.retryCount} retries)`;
      content += ` Required ${input.retryCount} retries to complete.`;
    }
  } else {
    type = "anti_pattern";
    title = `Failed: ${input.taskTitle}`;
    content = input.error ?? `Task "${input.taskTitle}" failed.`;
  }

  return storeKnowledge({
    type,
    title,
    content,
    domain: input.domain,
    tags: input.taskTags,
    sourceTaskId: input.taskId,
    sourceAgentId: input.agentId,
    outcome: input.outcome,
    confidence: input.agentPerformanceScore ?? 0.5,
    contextSnapshot: {
      taskTitle: input.taskTitle,
      retryCount: input.retryCount ?? 0,
      error: input.error,
    },
  });
}
