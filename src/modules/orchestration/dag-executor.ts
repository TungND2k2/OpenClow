import { eq, sql, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { tasks, taskDependencies } from "../../db/schema.js";
import {
  getTask,
  getSubtasks,
  areDependenciesSatisfied,
} from "../tasks/task.service.js";
import type { TaskRecord } from "../tasks/task.types.js";
import { getPlanByRootTask, updatePlanStatus } from "./decomposer.js";

/**
 * Find subtasks that are ready to execute:
 * status = 'pending' and all dependencies satisfied.
 */
export async function findReadyTasks(parentTaskId: string): Promise<TaskRecord[]> {
  const subtasks = await getSubtasks(parentTaskId);
  const ready: TaskRecord[] = [];
  for (const t of subtasks) {
    if (t.status === "pending" && (await areDependenciesSatisfied(t.id))) {
      ready.push(t);
    }
  }
  return ready;
}

/**
 * Check if all subtasks of a parent are completed.
 * Returns status: 'all_completed' | 'has_failed' | 'in_progress'
 */
export async function checkSubtaskCompletion(parentTaskId: string): Promise<{
  status: "all_completed" | "has_failed" | "in_progress";
  completed: number;
  failed: number;
  total: number;
  failedBeyondRetries: boolean;
}> {
  const subtasks = await getSubtasks(parentTaskId);
  const total = subtasks.length;
  if (total === 0) {
    return {
      status: "all_completed",
      completed: 0,
      failed: 0,
      total: 0,
      failedBeyondRetries: false,
    };
  }

  const completed = subtasks.filter((t) => t.status === "completed").length;
  const failed = subtasks.filter((t) => t.status === "failed").length;
  const cancelled = subtasks.filter((t) => t.status === "cancelled").length;

  const failedBeyondRetries = subtasks.some(
    (t) => t.status === "failed" && t.retryCount >= t.maxRetries
  );

  if (completed + cancelled === total) {
    return { status: "all_completed", completed, failed, total, failedBeyondRetries };
  }
  if (failedBeyondRetries) {
    return { status: "has_failed", completed, failed, total, failedBeyondRetries };
  }
  return { status: "in_progress", completed, failed, total, failedBeyondRetries };
}

/**
 * Resolve dependencies: find task_dependencies where depends_on is completed
 * and mark them as satisfied. Then find blocked tasks that can now proceed.
 */
export async function resolveDependencies(): Promise<{
  satisfiedCount: number;
  unblockedTaskIds: string[];
}> {
  const db = getDb();
  let satisfiedCount = 0;
  const unblockedTaskIds: string[] = [];

  // Find pending dependencies whose prerequisite is completed
  const pendingDeps = await db
    .select({
      taskId: taskDependencies.taskId,
      dependsOnId: taskDependencies.dependsOnId,
    })
    .from(taskDependencies)
    .where(eq(taskDependencies.status, "pending"));

  for (const dep of pendingDeps) {
    const prerequisite = await getTask(dep.dependsOnId);
    if (!prerequisite) continue;

    if (prerequisite.status === "completed") {
      await db.update(taskDependencies)
        .set({ status: "satisfied" as const })
        .where(
          and(
            eq(taskDependencies.taskId, dep.taskId),
            eq(taskDependencies.dependsOnId, dep.dependsOnId)
          )
        );
      satisfiedCount++;
    } else if (
      prerequisite.status === "failed" ||
      prerequisite.status === "cancelled"
    ) {
      await db.update(taskDependencies)
        .set({ status: "failed" as const })
        .where(
          and(
            eq(taskDependencies.taskId, dep.taskId),
            eq(taskDependencies.dependsOnId, dep.dependsOnId)
          )
        );
    }
  }

  // Find blocked tasks where all deps are now satisfied
  const blockedTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, "blocked"));

  for (const task of blockedTasks) {
    if (await areDependenciesSatisfied(task.id)) {
      await db.update(tasks)
        .set({ status: "pending" as const })
        .where(eq(tasks.id, task.id));
      unblockedTaskIds.push(task.id);
    }
  }

  return { satisfiedCount, unblockedTaskIds };
}

/**
 * Rollup: check parent tasks with delegated status and auto-complete if
 * all subtasks are done.
 */
export async function rollupParentTasks(): Promise<{
  completedParents: string[];
  blockedParents: string[];
}> {
  const db = getDb();
  const completedParents: string[] = [];
  const blockedParents: string[] = [];

  const delegatedTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.status, "delegated"));

  for (const parent of delegatedTasks) {
    const result = await checkSubtaskCompletion(parent.id);

    if (result.status === "all_completed") {
      // Auto-complete parent
      await db.update(tasks)
        .set({
          status: "completed" as const,
          result: `All ${result.total} subtasks completed (${result.completed} success)`,
          completedAt: Date.now(),
        })
        .where(eq(tasks.id, parent.id));
      completedParents.push(parent.id);

      // Update plan status
      const plan = await getPlanByRootTask(parent.id);
      if (plan) await updatePlanStatus(plan.id, "completed");

      // Satisfy dependencies on this parent
      await db.update(taskDependencies)
        .set({ status: "satisfied" as const })
        .where(eq(taskDependencies.dependsOnId, parent.id));
    } else if (result.failedBeyondRetries) {
      // Block parent
      await db.update(tasks)
        .set({ status: "blocked" as const })
        .where(eq(tasks.id, parent.id));
      blockedParents.push(parent.id);

      const plan = await getPlanByRootTask(parent.id);
      if (plan) await updatePlanStatus(plan.id, "failed");
    }
  }

  return { completedParents, blockedParents };
}
