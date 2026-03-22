import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { agents } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";
import {
  type Role,
  AUTHORITY_LEVELS,
} from "../hierarchy/hierarchy.types.js";
import { insertHierarchyEntries } from "../hierarchy/hierarchy.queries.js";

export interface CreateAgentInput {
  name: string;
  capabilities: string[];
  role?: Role;
  parentAgentId?: string;
  maxConcurrentTasks?: number;
  costBudgetUsd?: number;
  config?: Record<string, unknown>;
  templateId?: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  templateId: string | null;
  role: Role;
  authorityLevel: number;
  capabilities: string[];
  parentAgentId: string | null;
  status: string;
  performanceScore: number;
  tasksCompleted: number;
  tasksFailed: number;
  maxConcurrentTasks: number;
  costBudgetUsd: number | null;
  costSpentUsd: number;
  lastHeartbeat: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Register a new agent.
 */
export async function registerAgent(input: CreateAgentInput): Promise<AgentRecord> {
  const db = getDb();
  const now = nowMs();
  const role = input.role ?? "worker";
  const authorityLevel = AUTHORITY_LEVELS[role];
  const id = newId();

  // Enforce single commander
  if (role === "commander") {
    const existing = (await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.role, "commander"))
      .limit(1))[0];
    if (existing) {
      throw new Error(
        `Commander already exists (${existing.id}). Only one commander allowed.`
      );
    }
  }

  const record = {
    id,
    name: input.name,
    templateId: input.templateId ?? null,
    role,
    authorityLevel,
    capabilities: JSON.stringify(input.capabilities),
    parentAgentId: input.parentAgentId ?? null,
    status: "registering" as const,
    performanceScore: 0.5,
    tasksCompleted: 0,
    tasksFailed: 0,
    maxConcurrentTasks: input.maxConcurrentTasks ?? 1,
    costBudgetUsd: input.costBudgetUsd ?? null,
    costSpentUsd: 0.0,
    config: input.config ? JSON.stringify(input.config) : "{}",
    lastHeartbeat: now,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(agents).values(record);

  // Insert hierarchy closure table entries
  await insertHierarchyEntries(id, input.parentAgentId ?? null);

  return {
    ...record,
    capabilities: input.capabilities,
    status: "registering",
  } as AgentRecord;
}

/**
 * Update agent heartbeat timestamp and set status to idle if registering.
 */
export async function heartbeat(agentId: string): Promise<void> {
  const db = getDb();
  const now = nowMs();

  const agent = (await db
    .select({ status: agents.status })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1))[0];

  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const newStatus =
    agent.status === "registering" || agent.status === "offline"
      ? ("idle" as const)
      : undefined;

  await db.update(agents)
    .set({
      lastHeartbeat: now,
      updatedAt: now,
      ...(newStatus ? { status: newStatus } : {}),
    })
    .where(eq(agents.id, agentId));
}

/**
 * Get agent by ID.
 */
export async function getAgent(agentId: string): Promise<AgentRecord | null> {
  const db = getDb();
  const row = (await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1))[0];

  if (!row) return null;

  return {
    ...row,
    capabilities: row.capabilities as unknown as string[],
    role: row.role as Role,
  } as AgentRecord;
}

/**
 * List agents with optional filters.
 */
export async function listAgents(filters?: {
  status?: string;
  role?: string;
}): Promise<AgentRecord[]> {
  const db = getDb();

  const rows = await db.select().from(agents);

  let result = rows;
  if (filters?.status) {
    result = result.filter((r) => r.status === filters.status);
  }
  if (filters?.role) {
    result = result.filter((r) => r.role === filters.role);
  }

  return result.map((row) => ({
    ...row,
    capabilities: row.capabilities as unknown as string[],
    role: row.role as Role,
  })) as AgentRecord[];
}

/**
 * Update agent status.
 */
export async function updateAgentStatus(
  agentId: string,
  status: "registering" | "idle" | "busy" | "suspended" | "offline" | "deactivated"
): Promise<void> {
  const db = getDb();
  await db.update(agents)
    .set({ status, updatedAt: nowMs() })
    .where(eq(agents.id, agentId));
}

/**
 * Update performance score after task completion.
 * Uses exponential moving average: new = old * 0.9 + (success ? 0.1 : 0.0)
 */
export async function updatePerformance(
  agentId: string,
  success: boolean
): Promise<void> {
  const db = getDb();
  const agent = (await db
    .select({
      performanceScore: agents.performanceScore,
      tasksCompleted: agents.tasksCompleted,
      tasksFailed: agents.tasksFailed,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1))[0];

  if (!agent) return;

  const newScore =
    agent.performanceScore * 0.9 + (success ? 0.1 : 0.0);

  await db.update(agents)
    .set({
      performanceScore: newScore,
      tasksCompleted: success
        ? agent.tasksCompleted + 1
        : agent.tasksCompleted,
      tasksFailed: success
        ? agent.tasksFailed
        : agent.tasksFailed + 1,
      updatedAt: nowMs(),
    })
    .where(eq(agents.id, agentId));
}
