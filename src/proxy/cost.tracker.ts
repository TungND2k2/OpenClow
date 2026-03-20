import { getDb } from "../db/connection.js";
import { tokenUsage, agents } from "../db/schema.js";
import { newId } from "../utils/id.js";
import { nowMs } from "../utils/clock.js";
import { eq, sql } from "drizzle-orm";

// Model pricing (USD per 1M tokens)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-haiku-4-20250514": { input: 0.25, output: 1.25 },
};

/**
 * Calculate cost for a request.
 */
export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? { input: 3, output: 15 }; // default sonnet pricing
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/**
 * Record token usage for an agent/task.
 */
export async function recordUsage(input: {
  agentId: string;
  taskId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<{ id: string; costUsd: number }> {
  const db = getDb();
  const now = nowMs();
  const id = newId();
  const costUsd = calculateCost(input.model, input.inputTokens, input.outputTokens);

  await db.insert(tokenUsage).values({
    id,
    agentId: input.agentId,
    taskId: input.taskId ?? null,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costUsd,
    createdAt: now,
  });

  // Update agent's cost_spent
  await db.execute(sql`UPDATE agents SET cost_spent_usd = cost_spent_usd + ${costUsd} WHERE id = ${input.agentId}`);

  return { id, costUsd };
}

/**
 * Check if an agent is within budget.
 */
export async function checkBudget(agentId: string): Promise<{ withinBudget: boolean; spent: number; budget: number | null }> {
  const db = getDb();
  const agent = (await db.select({
    costBudgetUsd: agents.costBudgetUsd,
    costSpentUsd: agents.costSpentUsd,
  }).from(agents).where(eq(agents.id, agentId)).limit(1))[0];

  if (!agent) return { withinBudget: false, spent: 0, budget: null };
  if (agent.costBudgetUsd === null) return { withinBudget: true, spent: agent.costSpentUsd, budget: null };

  return {
    withinBudget: agent.costSpentUsd <= agent.costBudgetUsd,
    spent: agent.costSpentUsd,
    budget: agent.costBudgetUsd,
  };
}

/**
 * Register custom model pricing.
 */
export function setModelPricing(model: string, inputPerMillion: number, outputPerMillion: number): void {
  MODEL_PRICING[model] = { input: inputPerMillion, output: outputPerMillion };
}
