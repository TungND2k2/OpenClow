import { eq, and, sql, desc } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { decisions } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";

export type DecisionType =
  | "decompose"
  | "assign"
  | "reassign"
  | "retry"
  | "escalate"
  | "cancel"
  | "promote"
  | "demote"
  | "spawn"
  | "kill";

export interface DecisionRecord {
  id: string;
  agentId: string;
  decisionType: DecisionType;
  taskId: string | null;
  targetAgentId: string | null;
  reasoning: string;
  inputContext: Record<string, unknown> | null;
  outcome: string | null;
  createdAt: number;
}

export interface RecordDecisionInput {
  agentId: string;
  decisionType: DecisionType;
  taskId?: string;
  targetAgentId?: string;
  reasoning: string;
  inputContext?: Record<string, unknown>;
  outcome?: string;
}

/**
 * Record a decision in the audit trail.
 */
export async function recordDecision(input: RecordDecisionInput): Promise<DecisionRecord> {
  const db = getDb();
  const now = nowMs();
  const id = newId();

  const record = {
    id,
    agentId: input.agentId,
    decisionType: input.decisionType,
    taskId: input.taskId ?? null,
    targetAgentId: input.targetAgentId ?? null,
    reasoning: input.reasoning,
    inputContext: input.inputContext
      ? JSON.stringify(input.inputContext)
      : null,
    outcome: input.outcome ?? null,
    createdAt: now,
  };

  await db.insert(decisions).values(record);

  return {
    id,
    agentId: input.agentId,
    decisionType: input.decisionType,
    taskId: input.taskId ?? null,
    targetAgentId: input.targetAgentId ?? null,
    reasoning: input.reasoning,
    inputContext: input.inputContext ?? null,
    outcome: input.outcome ?? null,
    createdAt: now,
  };
}

/**
 * Query decision audit trail.
 */
export async function queryDecisions(filters?: {
  agentId?: string;
  taskId?: string;
  decisionType?: DecisionType;
  limit?: number;
}): Promise<DecisionRecord[]> {
  const db = getDb();
  const conditions: any[] = [];

  if (filters?.agentId) {
    conditions.push(eq(decisions.agentId, filters.agentId));
  }
  if (filters?.taskId) {
    conditions.push(eq(decisions.taskId, filters.taskId));
  }
  if (filters?.decisionType) {
    conditions.push(eq(decisions.decisionType, filters.decisionType));
  }

  const rows = await db
    .select()
    .from(decisions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(decisions.createdAt))
    .limit(filters?.limit ?? 50);

  return rows.map((r) => ({
    ...r,
    decisionType: r.decisionType as DecisionType,
    inputContext: r.inputContext as Record<string, unknown> | null,
  }));
}
