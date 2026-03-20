import { eq, sql, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { agents, tasks, tokenUsage } from "../../db/schema.js";
import { nowMs } from "../../utils/clock.js";
import { updateAgentStatus } from "../agents/agent.service.js";
import { recordDecision } from "../decisions/decision.service.js";
import { sendMessage } from "../messaging/message.service.js";

/**
 * Suspend an agent — freeze it and reassign its tasks.
 */
export async function suspendAgent(
  agentId: string,
  reason: string,
  requestingAgentId: string
): Promise<{ reassignedTaskIds: string[] }> {
  const db = getDb();
  await updateAgentStatus(agentId, "suspended");

  // Reassign active tasks
  const activeTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.assignedAgentId, agentId),
        sql`${tasks.status} IN ('assigned', 'in_progress')`
      )
    );

  const reassignedTaskIds: string[] = [];
  for (const task of activeTasks) {
    await db.update(tasks)
      .set({
        status: "pending" as const,
        assignedAgentId: null,
        assignedAt: null,
        startedAt: null,
      })
      .where(eq(tasks.id, task.id));
    reassignedTaskIds.push(task.id);
  }

  await recordDecision({
    agentId: requestingAgentId,
    decisionType: "kill",
    targetAgentId: agentId,
    reasoning: `Suspended: ${reason}. ${reassignedTaskIds.length} tasks reassigned.`,
  });

  return { reassignedTaskIds };
}

/**
 * Permanently deactivate an agent.
 */
export async function killAgent(
  agentId: string,
  reason: string,
  requestingAgentId: string
): Promise<void> {
  const result = await suspendAgent(agentId, reason, requestingAgentId);
  await updateAgentStatus(agentId, "deactivated");
}

/**
 * Set cost budget for an agent.
 */
export async function setAgentBudget(
  agentId: string,
  budgetUsd: number
): Promise<void> {
  const db = getDb();
  await db.update(agents)
    .set({ costBudgetUsd: budgetUsd, updatedAt: nowMs() })
    .where(eq(agents.id, agentId));
}

/**
 * Get a dashboard summary of the system.
 */
export async function getDashboard(): Promise<{
  agents: {
    total: number;
    byStatus: Record<string, number>;
    byRole: Record<string, number>;
  };
  tasks: {
    total: number;
    byStatus: Record<string, number>;
  };
  costs: {
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
}> {
  const db = getDb();

  // Agent stats
  const allAgents = await db
    .select({ status: agents.status, role: agents.role })
    .from(agents);

  const agentsByStatus: Record<string, number> = {};
  const agentsByRole: Record<string, number> = {};
  for (const a of allAgents) {
    agentsByStatus[a.status] = (agentsByStatus[a.status] ?? 0) + 1;
    agentsByRole[a.role] = (agentsByRole[a.role] ?? 0) + 1;
  }

  // Task stats
  const allTasks = await db
    .select({ status: tasks.status })
    .from(tasks);

  const tasksByStatus: Record<string, number> = {};
  for (const t of allTasks) {
    tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;
  }

  // Cost stats
  const costRow = (await db
    .select({
      totalCost: sql<number>`COALESCE(SUM(${tokenUsage.costUsd}), 0)`,
      totalInput: sql<number>`COALESCE(SUM(${tokenUsage.inputTokens}), 0)`,
      totalOutput: sql<number>`COALESCE(SUM(${tokenUsage.outputTokens}), 0)`,
    })
    .from(tokenUsage))[0];

  return {
    agents: {
      total: allAgents.length,
      byStatus: agentsByStatus,
      byRole: agentsByRole,
    },
    tasks: {
      total: allTasks.length,
      byStatus: tasksByStatus,
    },
    costs: {
      totalCostUsd: costRow?.totalCost ?? 0,
      totalInputTokens: costRow?.totalInput ?? 0,
      totalOutputTokens: costRow?.totalOutput ?? 0,
    },
  };
}

/**
 * Find stale tasks (in_progress for too long).
 */
export async function findStaleTasks(
  thresholdMs: number = 600000 // 10 minutes default
): Promise<{ id: string; title: string; assignedAgentId: string | null; startedAt: number }[]> {
  const db = getDb();
  const cutoff = nowMs() - thresholdMs;

  return await db
    .select({
      id: tasks.id,
      title: tasks.title,
      assignedAgentId: tasks.assignedAgentId,
      startedAt: tasks.startedAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "in_progress"),
        sql`${tasks.startedAt} IS NOT NULL AND ${tasks.startedAt} < ${cutoff}`
      )
    ) as any[];
}
