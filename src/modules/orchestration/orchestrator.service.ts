import { eq, sql, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { agents, tasks } from "../../db/schema.js";
import { getConfig } from "../../config.js";
import { nowMs } from "../../utils/clock.js";
import { resolveDependencies, rollupParentTasks, findReadyTasks } from "./dag-executor.js";
import { selectBestAgentGlobal } from "./decision-engine.js";
import { recordDecision } from "../decisions/decision.service.js";
import { sendMessage } from "../messaging/message.service.js";
import { updateAgentStatus, updatePerformance } from "../agents/agent.service.js";
import { assignTask } from "../tasks/task.service.js";

export interface TickResult {
  offlineAgents: string[];
  satisfiedDeps: number;
  unblockedTasks: string[];
  assignedTasks: { taskId: string; agentId: string }[];
  completedParents: string[];
  blockedParents: string[];
  overBudgetAgents: string[];
}

/**
 * Run one orchestrator tick — the autonomous heartbeat of the system.
 */
export async function tick(): Promise<TickResult> {
  const result: TickResult = {
    offlineAgents: [],
    satisfiedDeps: 0,
    unblockedTasks: [],
    assignedTasks: [],
    completedParents: [],
    blockedParents: [],
    overBudgetAgents: [],
  };

  const config = getConfig();
  const now = nowMs();

  // ── 1. HEALTH CHECK ──────────────────────────────────────
  const db = getDb();
  const heartbeatThreshold = now - config.HEARTBEAT_TIMEOUT_MS;
  const staleAgents = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(
      and(
        sql`${agents.status} IN ('idle', 'busy')`,
        sql`${agents.lastHeartbeat} < ${heartbeatThreshold}`
      )
    );

  for (const agent of staleAgents) {
    await updateAgentStatus(agent.id, "offline");
    result.offlineAgents.push(agent.id);

    // Reassign their in-progress tasks
    const agentTasks = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.assignedAgentId, agent.id),
          sql`${tasks.status} IN ('assigned', 'in_progress')`
        )
      );

    for (const task of agentTasks) {
      await db.update(tasks)
        .set({
          status: "pending" as const,
          assignedAgentId: null,
          assignedAt: null,
          startedAt: null,
        })
        .where(eq(tasks.id, task.id));

      await recordDecision({
        agentId: "system",
        decisionType: "reassign",
        taskId: task.id,
        targetAgentId: agent.id,
        reasoning: `Agent ${agent.name} went offline, task reset to pending`,
      });
    }
  }

  // ── 2. DEPENDENCY RESOLUTION ─────────────────────────────
  const depResult = await resolveDependencies();
  result.satisfiedDeps = depResult.satisfiedCount;
  result.unblockedTasks = depResult.unblockedTaskIds;

  // ── 3. PENDING TASK ASSIGNMENT ───────────────────────────
  const pendingTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "pending"),
        sql`${tasks.assignedAgentId} IS NULL`
      )
    )
    .orderBy(sql`${tasks.priority} DESC, ${tasks.urgency} DESC, ${tasks.createdAt} ASC`)
    .limit(20);

  for (const task of pendingTasks) {
    const requiredCaps =
      (task.requiredCapabilities as unknown as string[]) ?? [];
    const best = await selectBestAgentGlobal(requiredCaps);

    if (best) {
      await assignTask(task.id, best.agentId, "system");
      result.assignedTasks.push({
        taskId: task.id,
        agentId: best.agentId,
      });

      // Send command message to agent
      await sendMessage({
        fromAgentId: "system",
        toAgentId: best.agentId,
        type: "command",
        taskId: task.id,
        payload: {
          action: "execute_task",
          taskId: task.id,
          title: task.title,
        },
      });

      await recordDecision({
        agentId: "system",
        decisionType: "assign",
        taskId: task.id,
        targetAgentId: best.agentId,
        reasoning: `Auto-assigned to ${best.agentId} (score: ${best.score.toFixed(3)}, capability: ${best.capabilityMatch.toFixed(2)}, availability: ${best.availability.toFixed(2)})`,
        inputContext: { ...best },
      });
    }
  }

  // ── 4. PROGRESS ROLLUP ───────────────────────────────────
  const rollup = await rollupParentTasks();
  result.completedParents = rollup.completedParents;
  result.blockedParents = rollup.blockedParents;

  // ── 5. BUDGET CHECK ──────────────────────────────────────
  const overBudget = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        sql`${agents.costBudgetUsd} IS NOT NULL`,
        sql`${agents.costSpentUsd} > ${agents.costBudgetUsd}`,
        sql`${agents.status} NOT IN ('suspended', 'deactivated')`
      )
    );

  for (const agent of overBudget) {
    await updateAgentStatus(agent.id, "suspended");
    result.overBudgetAgents.push(agent.id);

    await recordDecision({
      agentId: "system",
      decisionType: "kill",
      targetAgentId: agent.id,
      reasoning: "Agent exceeded cost budget, suspended",
    });
  }

  return result;
}

// ── Tick loop management ─────────────────────────────────────

let _interval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the orchestrator tick loop.
 */
export function startOrchestrator(): void {
  if (_interval) return;
  const config = getConfig();
  _interval = setInterval(() => {
    try {
      tick();
    } catch (err) {
      console.error("[Orchestrator] Tick error:", err);
    }
  }, config.ORCHESTRATOR_TICK_MS);
  console.log(
    `[Orchestrator] Started (tick every ${config.ORCHESTRATOR_TICK_MS}ms)`
  );
}

/**
 * Stop the orchestrator tick loop.
 */
export function stopOrchestrator(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    console.log("[Orchestrator] Stopped");
  }
}
