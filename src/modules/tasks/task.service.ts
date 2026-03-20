import { eq, and, sql, inArray, desc } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { tasks, taskDependencies } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";
import {
  type TaskStatus,
  type TaskRecord,
  type CreateTaskInput,
  VALID_TRANSITIONS,
} from "./task.types.js";

// ── Helpers ──────────────────────────────────────────────────

function toRecord(row: any): TaskRecord {
  return {
    ...row,
    dependencyIds: row.dependencyIds ?? [],
    requiredCapabilities: row.requiredCapabilities ?? [],
    tags: row.tags ?? [],
  } as TaskRecord;
}

function assertTransition(current: TaskStatus, next: TaskStatus): void {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new Error(
      `Invalid transition: ${current} → ${next}. Allowed: ${allowed.join(", ") || "none"}`
    );
  }
}

// ── CRUD ─────────────────────────────────────────────────────

export async function createTask(input: CreateTaskInput): Promise<TaskRecord> {
  const db = getDb();
  const now = nowMs();
  const id = newId();

  // Calculate depth from parent
  let depth = 0;
  if (input.parentTaskId) {
    const parent = (await db
      .select({ depth: tasks.depth, maxDepth: tasks.maxDepth })
      .from(tasks)
      .where(eq(tasks.id, input.parentTaskId))
      .limit(1))[0];
    if (!parent) throw new Error(`Parent task ${input.parentTaskId} not found`);
    depth = parent.depth + 1;
    if (depth > parent.maxDepth) {
      throw new Error(
        `Max decomposition depth ${parent.maxDepth} exceeded (depth would be ${depth})`
      );
    }
  }

  const record = {
    id,
    title: input.title,
    description: input.description ?? null,
    status: "pending" as const,
    priority: input.priority ?? 3,
    urgency: input.urgency ?? 3,
    assignedAgentId: null,
    createdByAgentId: input.createdByAgentId ?? null,
    delegatedByAgentId: null,
    parentTaskId: input.parentTaskId ?? null,
    executionStrategy: input.executionStrategy ?? null,
    dependencyIds: "[]",
    depth,
    maxDepth: 5,
    retryCount: 0,
    maxRetries: input.maxRetries ?? 3,
    escalationAgentId: null,
    requiredCapabilities: JSON.stringify(input.requiredCapabilities ?? []),
    estimatedDurationMs: input.estimatedDurationMs ?? null,
    costBudgetUsd: input.costBudgetUsd ?? null,
    costSpentUsd: 0.0,
    tags: JSON.stringify(input.tags ?? []),
    result: null,
    error: null,
    createdAt: now,
    assignedAt: null,
    startedAt: null,
    completedAt: null,
    deadline: input.deadline ?? null,
  };

  await db.insert(tasks).values(record);

  return toRecord({ ...record, dependencyIds: [], requiredCapabilities: input.requiredCapabilities ?? [], tags: input.tags ?? [] });
}

export async function getTask(taskId: string): Promise<TaskRecord | null> {
  const db = getDb();
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0];
  return row ? toRecord(row) : null;
}

export async function listTasks(filters?: {
  status?: TaskStatus;
  assignedTo?: string;
  priorityMin?: number;
  tags?: string[];
  parentTaskId?: string;
  limit?: number;
}): Promise<TaskRecord[]> {
  const db = getDb();
  const conditions: any[] = [];

  if (filters?.status) {
    conditions.push(eq(tasks.status, filters.status));
  }
  if (filters?.assignedTo) {
    conditions.push(eq(tasks.assignedAgentId, filters.assignedTo));
  }
  if (filters?.priorityMin) {
    conditions.push(sql`${tasks.priority} >= ${filters.priorityMin}`);
  }
  if (filters?.parentTaskId) {
    conditions.push(eq(tasks.parentTaskId, filters.parentTaskId));
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(tasks.priority), desc(tasks.urgency))
    .limit(filters?.limit ?? 100);

  let result = rows;
  if (filters?.tags && filters.tags.length > 0) {
    result = rows.filter((r) => {
      const taskTags = (r.tags as unknown as string[]) ?? [];
      return filters.tags!.some((t) => taskTags.includes(t));
    });
  }

  return result.map(toRecord);
}

// ── Lifecycle transitions ────────────────────────────────────

/**
 * Agent claims an unassigned pending task.
 * Uses optimistic concurrency: only updates if status is still 'pending'.
 */
export async function claimTask(taskId: string, agentId: string): Promise<TaskRecord> {
  const db = getDb();
  const now = nowMs();

  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== "pending") {
    throw new Error(`Task ${taskId} is ${task.status}, cannot claim`);
  }

  const result = await db
    .update(tasks)
    .set({
      status: "assigned" as const,
      assignedAgentId: agentId,
      assignedAt: now,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "pending")))
    .returning({ id: tasks.id });

  if (result.length === 0) {
    throw new Error(`Task ${taskId} was claimed by another agent`);
  }

  return (await getTask(taskId))!;
}

/**
 * Assign task to a specific agent (by commander/supervisor).
 */
export async function assignTask(
  taskId: string,
  agentId: string,
  delegatedByAgentId: string
): Promise<TaskRecord> {
  const db = getDb();
  const now = nowMs();

  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  assertTransition(task.status, "assigned");

  await db.update(tasks)
    .set({
      status: "assigned" as const,
      assignedAgentId: agentId,
      delegatedByAgentId,
      assignedAt: now,
    })
    .where(eq(tasks.id, taskId));

  return (await getTask(taskId))!;
}

/**
 * Start working on an assigned task.
 */
export async function startTask(taskId: string, agentId: string): Promise<TaskRecord> {
  const db = getDb();
  const now = nowMs();

  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.assignedAgentId !== agentId) {
    throw new Error(`Task ${taskId} is not assigned to agent ${agentId}`);
  }
  assertTransition(task.status, "in_progress");

  await db.update(tasks)
    .set({ status: "in_progress" as const, startedAt: now })
    .where(eq(tasks.id, taskId));

  return (await getTask(taskId))!;
}

/**
 * Complete a task with result.
 */
export async function completeTask(
  taskId: string,
  agentId: string,
  result: string
): Promise<TaskRecord> {
  const db = getDb();
  const now = nowMs();

  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.assignedAgentId !== agentId) {
    throw new Error(`Task ${taskId} is not assigned to agent ${agentId}`);
  }
  assertTransition(task.status, "completed");

  await db.update(tasks)
    .set({
      status: "completed" as const,
      result,
      completedAt: now,
    })
    .where(eq(tasks.id, taskId));

  // Satisfy dependencies that depend on this task
  await db.update(taskDependencies)
    .set({ status: "satisfied" as const })
    .where(eq(taskDependencies.dependsOnId, taskId));

  return (await getTask(taskId))!;
}

/**
 * Fail a task with error.
 */
export async function failTask(
  taskId: string,
  agentId: string,
  error: string
): Promise<TaskRecord> {
  const db = getDb();
  const now = nowMs();

  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.assignedAgentId !== agentId) {
    throw new Error(`Task ${taskId} is not assigned to agent ${agentId}`);
  }
  assertTransition(task.status, "failed");

  await db.update(tasks)
    .set({
      status: "failed" as const,
      error,
      completedAt: now,
    })
    .where(eq(tasks.id, taskId));

  // Mark dependencies as failed
  await db.update(taskDependencies)
    .set({ status: "failed" as const })
    .where(eq(taskDependencies.dependsOnId, taskId));

  return (await getTask(taskId))!;
}

/**
 * Cancel a task.
 */
export async function cancelTask(taskId: string, reason?: string): Promise<TaskRecord> {
  const db = getDb();
  const now = nowMs();

  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  assertTransition(task.status, "cancelled");

  await db.update(tasks)
    .set({
      status: "cancelled" as const,
      error: reason ?? "cancelled",
      completedAt: now,
    })
    .where(eq(tasks.id, taskId));

  return (await getTask(taskId))!;
}

/**
 * Retry a failed task — resets to pending with incremented retry count.
 */
export async function retryTask(taskId: string): Promise<TaskRecord> {
  const db = getDb();

  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== "failed") {
    throw new Error(`Task ${taskId} is ${task.status}, only failed tasks can be retried`);
  }
  if (task.retryCount >= task.maxRetries) {
    throw new Error(
      `Task ${taskId} has exhausted retries (${task.retryCount}/${task.maxRetries})`
    );
  }

  await db.update(tasks)
    .set({
      status: "pending" as const,
      assignedAgentId: null,
      delegatedByAgentId: null,
      retryCount: task.retryCount + 1,
      error: null,
      assignedAt: null,
      startedAt: null,
      completedAt: null,
    })
    .where(eq(tasks.id, taskId));

  return (await getTask(taskId))!;
}

/**
 * Mark task as delegated (has subtasks).
 */
export async function delegateTask(taskId: string): Promise<TaskRecord> {
  const db = getDb();

  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  assertTransition(task.status, "delegated");

  await db.update(tasks)
    .set({ status: "delegated" as const })
    .where(eq(tasks.id, taskId));

  return (await getTask(taskId))!;
}

/**
 * Mark task as blocked.
 */
export async function blockTask(taskId: string): Promise<TaskRecord> {
  const db = getDb();

  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  assertTransition(task.status, "blocked");

  await db.update(tasks)
    .set({ status: "blocked" as const })
    .where(eq(tasks.id, taskId));

  return (await getTask(taskId))!;
}

// ── Dependencies ─────────────────────────────────────────────

/**
 * Add a dependency: taskId depends on dependsOnId.
 */
export async function addDependency(taskId: string, dependsOnId: string): Promise<void> {
  const db = getDb();
  await db.insert(taskDependencies)
    .values({ taskId, dependsOnId, status: "pending" });
}

/**
 * Check if all dependencies of a task are satisfied.
 */
export async function areDependenciesSatisfied(taskId: string): Promise<boolean> {
  const db = getDb();
  const pending = (await db
    .select({ count: sql<number>`count(*)` })
    .from(taskDependencies)
    .where(
      and(
        eq(taskDependencies.taskId, taskId),
        sql`${taskDependencies.status} != 'satisfied'`
      )
    )
    .limit(1))[0];
  return (pending?.count ?? 0) === 0;
}

/**
 * Get subtasks of a parent task.
 */
export async function getSubtasks(parentTaskId: string): Promise<TaskRecord[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId));
  return rows.map(toRecord);
}
