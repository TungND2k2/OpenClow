import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { agents, tasks } from "../../db/schema.js";
import { getDescendants } from "../hierarchy/hierarchy.queries.js";
import type { AgentScore } from "./orchestration.types.js";

/**
 * Jaccard similarity between two string arrays.
 */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Score agents for a task and return ranked list.
 * Weights: capability 0.4, availability 0.3, performance 0.2, cost 0.1
 */
export async function scoreAgents(
  taskRequiredCapabilities: string[],
  candidateAgentIds?: string[]
): Promise<AgentScore[]> {
  const db = getDb();

  let agentRows = (await db
    .select({
      id: agents.id,
      capabilities: agents.capabilities,
      status: agents.status,
      performanceScore: agents.performanceScore,
      maxConcurrentTasks: agents.maxConcurrentTasks,
      costBudgetUsd: agents.costBudgetUsd,
      costSpentUsd: agents.costSpentUsd,
    })
    .from(agents))
    .filter(
      (a) =>
        a.status === "idle" || a.status === "busy"
    );

  if (candidateAgentIds) {
    const idSet = new Set(candidateAgentIds);
    agentRows = agentRows.filter((a) => idSet.has(a.id));
  }

  const scores: AgentScore[] = [];

  for (const agent of agentRows) {
    let caps: string[];
    if (typeof agent.capabilities === "string") {
      try { caps = JSON.parse(agent.capabilities); } catch { caps = []; }
    } else {
      caps = (agent.capabilities as unknown as string[]) ?? [];
    }
    const capabilityMatch = jaccard(taskRequiredCapabilities, caps);

    // Skip agents with zero capability match (unless task has no requirements)
    if (capabilityMatch === 0 && taskRequiredCapabilities.length > 0) continue;

    // Count active tasks for this agent
    const activeCount = (await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        sql`${tasks.assignedAgentId} = ${agent.id} AND ${tasks.status} IN ('assigned', 'in_progress')`
      ))[0];
    const activeTasks = activeCount?.count ?? 0;

    // Skip fully loaded agents
    if (activeTasks >= agent.maxConcurrentTasks) continue;

    const availability = 1.0 - activeTasks / agent.maxConcurrentTasks;
    const performance = agent.performanceScore;

    let costEfficiency = 1.0;
    if (agent.costBudgetUsd && agent.costBudgetUsd > 0) {
      costEfficiency = Math.max(
        0,
        1.0 - agent.costSpentUsd / agent.costBudgetUsd
      );
    }

    const score =
      capabilityMatch * 0.4 +
      availability * 0.3 +
      performance * 0.2 +
      costEfficiency * 0.1;

    scores.push({
      agentId: agent.id,
      score,
      capabilityMatch,
      availability,
      performance,
      costEfficiency,
    });
  }

  return scores.sort((a, b) => b.score - a.score);
}

/**
 * Select the best agent for a task from subordinates of a given supervisor.
 */
export async function selectBestAgent(
  supervisorId: string,
  taskRequiredCapabilities: string[]
): Promise<AgentScore | null> {
  const descendants = await getDescendants(supervisorId);
  const candidateIds = descendants.map((d) => d.descendantId);

  if (candidateIds.length === 0) return null;

  const ranked = await scoreAgents(taskRequiredCapabilities, candidateIds);
  return ranked.length > 0 ? ranked[0] : null;
}

/**
 * Select the best agent globally.
 */
export async function selectBestAgentGlobal(
  taskRequiredCapabilities: string[]
): Promise<AgentScore | null> {
  const ranked = await scoreAgents(taskRequiredCapabilities);
  return ranked.length > 0 ? ranked[0] : null;
}
