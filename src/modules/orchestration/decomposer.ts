import { eq } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { executionPlans } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";
import {
  createTask,
  addDependency,
  delegateTask,
  getTask,
} from "../tasks/task.service.js";
import { recordDecision } from "../decisions/decision.service.js";
import type {
  DecomposeInput,
  ExecutionPlanRecord,
  PlanGraph,
} from "./orchestration.types.js";

/**
 * Decompose a task into subtasks and create an execution plan.
 */
export async function decomposeTask(input: DecomposeInput): Promise<{
  plan: ExecutionPlanRecord;
  subtaskIds: string[];
}> {
  const db = getDb();
  const now = nowMs();

  const parentTask = await getTask(input.taskId);
  if (!parentTask) throw new Error(`Task ${input.taskId} not found`);

  if (input.subtasks.length === 0) {
    throw new Error("At least one subtask is required");
  }

  // Create subtasks
  const subtaskIds: string[] = [];
  const nodes: PlanGraph["nodes"] = [];
  const edges: PlanGraph["edges"] = [];

  for (let i = 0; i < input.subtasks.length; i++) {
    const sub = input.subtasks[i];
    const created = await createTask({
      title: sub.title,
      description: sub.description,
      parentTaskId: input.taskId,
      requiredCapabilities: sub.requiredCapabilities,
      estimatedDurationMs: sub.estimatedDurationMs,
      createdByAgentId: input.agentId,
    });
    subtaskIds.push(created.id);

    nodes.push({
      taskId: created.id,
      title: sub.title,
      requiredCapabilities: sub.requiredCapabilities ?? [],
      dependsOn: [],
    });
  }

  // Set up dependencies based on indices
  for (let i = 0; i < input.subtasks.length; i++) {
    const sub = input.subtasks[i];
    if (sub.dependsOnIndices) {
      for (const depIdx of sub.dependsOnIndices) {
        if (depIdx < 0 || depIdx >= subtaskIds.length) {
          throw new Error(`Invalid dependency index ${depIdx} for subtask ${i}`);
        }
        await addDependency(subtaskIds[i], subtaskIds[depIdx]);
        nodes[i].dependsOn.push(subtaskIds[depIdx]);
        edges.push({ from: subtaskIds[depIdx], to: subtaskIds[i] });
      }
    }
  }

  // Create execution plan
  const strategy = input.strategy ?? "parallel";
  const planId = newId();
  const planGraph: PlanGraph = { nodes, edges };

  await db.insert(executionPlans)
    .values({
      id: planId,
      rootTaskId: input.taskId,
      createdByAgentId: input.agentId,
      strategy,
      planGraph: JSON.stringify(planGraph),
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });

  // Mark parent as delegated
  await delegateTask(input.taskId);

  // Record decision
  await recordDecision({
    agentId: input.agentId,
    decisionType: "decompose",
    taskId: input.taskId,
    reasoning: `Decomposed into ${subtaskIds.length} subtasks with ${strategy} strategy`,
    inputContext: {
      subtaskCount: subtaskIds.length,
      strategy,
      subtaskIds,
    },
  });

  const plan: ExecutionPlanRecord = {
    id: planId,
    rootTaskId: input.taskId,
    createdByAgentId: input.agentId,
    strategy,
    planGraph,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };

  return { plan, subtaskIds };
}

/**
 * Activate an execution plan — sets it to 'active'.
 */
export async function activatePlan(planId: string): Promise<void> {
  const db = getDb();
  await db.update(executionPlans)
    .set({ status: "active" as const, updatedAt: nowMs() })
    .where(eq(executionPlans.id, planId));
}

/**
 * Get execution plan by ID.
 */
export async function getPlan(planId: string): Promise<ExecutionPlanRecord | null> {
  const db = getDb();
  const row = (await db
    .select()
    .from(executionPlans)
    .where(eq(executionPlans.id, planId))
    .limit(1))[0];

  if (!row) return null;

  return {
    ...row,
    planGraph: row.planGraph as unknown as PlanGraph,
    strategy: row.strategy as ExecutionPlanRecord["strategy"],
    status: row.status as ExecutionPlanRecord["status"],
  };
}

/**
 * Get execution plan for a root task.
 */
export async function getPlanByRootTask(
  rootTaskId: string
): Promise<ExecutionPlanRecord | null> {
  const db = getDb();
  const row = (await db
    .select()
    .from(executionPlans)
    .where(eq(executionPlans.rootTaskId, rootTaskId))
    .limit(1))[0];

  if (!row) return null;

  return {
    ...row,
    planGraph: row.planGraph as unknown as PlanGraph,
    strategy: row.strategy as ExecutionPlanRecord["strategy"],
    status: row.status as ExecutionPlanRecord["status"],
  };
}

/**
 * Update plan status.
 */
export async function updatePlanStatus(
  planId: string,
  status: ExecutionPlanRecord["status"]
): Promise<void> {
  const db = getDb();
  await db.update(executionPlans)
    .set({ status, updatedAt: nowMs() })
    .where(eq(executionPlans.id, planId));
}
