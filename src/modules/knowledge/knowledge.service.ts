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
