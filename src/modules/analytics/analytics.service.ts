import { sql, eq, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { tasks, agents, tokenUsage } from "../../db/schema.js";

export interface TaskMetrics {
  total: number;
  byStatus: Record<string, number>;
  completionRate: number;
  avgDurationMs: number | null;
  avgRetries: number;
}

export interface CostReport {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
  byAgent: { agentId: string; costUsd: number; requests: number }[];
  byModel: { model: string; costUsd: number; requests: number }[];
}

export async function getTaskMetrics(filters?: {
  agentId?: string;
  since?: number;
  until?: number;
}): Promise<TaskMetrics> {
  const db = getDb();
  const conditions: any[] = [];
  if (filters?.agentId) conditions.push(eq(tasks.assignedAgentId, filters.agentId));
  if (filters?.since) conditions.push(sql`${tasks.createdAt} >= ${filters.since}`);
  if (filters?.until) conditions.push(sql`${tasks.createdAt} <= ${filters.until}`);
  const where = conditions.length ? and(...conditions) : undefined;

  const allTasks = await db.select({ status: tasks.status }).from(tasks).where(where);
  const byStatus: Record<string, number> = {};
  for (const t of allTasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

  const completed = byStatus["completed"] ?? 0;
  const failed = byStatus["failed"] ?? 0;
  const total = allTasks.length;
  const completionRate = completed + failed > 0 ? completed / (completed + failed) : 0;

  const durRow = (await db.select({
    avg: sql<number>`avg(${tasks.completedAt} - ${tasks.startedAt})`,
  }).from(tasks).where(
    and(...(conditions.length ? conditions : []), sql`${tasks.completedAt} IS NOT NULL AND ${tasks.startedAt} IS NOT NULL`)
  ))[0];

  const retryRow = (await db.select({
    avg: sql<number>`avg(${tasks.retryCount})`,
  }).from(tasks).where(where))[0];

  return {
    total,
    byStatus,
    completionRate,
    avgDurationMs: durRow?.avg ?? null,
    avgRetries: retryRow?.avg ?? 0,
  };
}

export async function getCostReport(filters?: {
  agentId?: string;
  since?: number;
  until?: number;
}): Promise<CostReport> {
  const db = getDb();
  const conditions: any[] = [];
  if (filters?.agentId) conditions.push(eq(tokenUsage.agentId, filters.agentId));
  if (filters?.since) conditions.push(sql`${tokenUsage.createdAt} >= ${filters.since}`);
  if (filters?.until) conditions.push(sql`${tokenUsage.createdAt} <= ${filters.until}`);
  const where = conditions.length ? and(...conditions) : undefined;

  const totals = (await db.select({
    cost: sql<number>`COALESCE(SUM(${tokenUsage.costUsd}), 0)`,
    input: sql<number>`COALESCE(SUM(${tokenUsage.inputTokens}), 0)`,
    output: sql<number>`COALESCE(SUM(${tokenUsage.outputTokens}), 0)`,
    count: sql<number>`count(*)`,
  }).from(tokenUsage).where(where))[0];

  const byAgent = await db.select({
    agentId: tokenUsage.agentId,
    costUsd: sql<number>`SUM(${tokenUsage.costUsd})`,
    requests: sql<number>`count(*)`,
  }).from(tokenUsage).where(where).groupBy(tokenUsage.agentId);

  const byModel = await db.select({
    model: tokenUsage.model,
    costUsd: sql<number>`SUM(${tokenUsage.costUsd})`,
    requests: sql<number>`count(*)`,
  }).from(tokenUsage).where(where).groupBy(tokenUsage.model);

  return {
    totalCostUsd: totals?.cost ?? 0,
    totalInputTokens: totals?.input ?? 0,
    totalOutputTokens: totals?.output ?? 0,
    requestCount: totals?.count ?? 0,
    byAgent,
    byModel,
  };
}

export async function getAgentPerformanceRanking(): Promise<{
  agentId: string;
  name: string;
  role: string;
  score: number;
  completed: number;
  failed: number;
}[]> {
  const db = getDb();
  return await db.select({
    agentId: agents.id,
    name: agents.name,
    role: agents.role,
    score: agents.performanceScore,
    completed: agents.tasksCompleted,
    failed: agents.tasksFailed,
  }).from(agents)
    .orderBy(sql`${agents.performanceScore} DESC`);
}
