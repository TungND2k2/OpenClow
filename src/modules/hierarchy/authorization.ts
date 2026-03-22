import { eq } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { agents } from "../../db/schema.js";
import { isAncestorOf } from "./hierarchy.queries.js";
import {
  type Action,
  type Role,
  ACTION_MIN_AUTHORITY,
  AUTHORITY_LEVELS,
} from "./hierarchy.types.js";

export class AuthorizationError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly action: Action,
    public readonly reason: string
  ) {
    super(`Agent ${agentId} not authorized for ${action}: ${reason}`);
    this.name = "AuthorizationError";
  }
}

interface AuthContext {
  actingAgentId: string;
  action: Action;
  targetAgentId?: string;
  targetTaskOwnerId?: string;
}

/**
 * Assert that an agent is authorized to perform an action.
 * Throws AuthorizationError if not.
 */
export async function assertAuthorized(ctx: AuthContext): Promise<void> {
  const db = getDb();

  const actingAgent = (await db
    .select({
      role: agents.role,
      authorityLevel: agents.authorityLevel,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, ctx.actingAgentId))
    .limit(1))[0];

  if (!actingAgent) {
    throw new AuthorizationError(
      ctx.actingAgentId,
      ctx.action,
      "agent not found"
    );
  }

  if (
    actingAgent.status === "deactivated" ||
    actingAgent.status === "suspended"
  ) {
    throw new AuthorizationError(
      ctx.actingAgentId,
      ctx.action,
      `agent is ${actingAgent.status}`
    );
  }

  // 1. Check minimum authority level for action
  const minAuthority = ACTION_MIN_AUTHORITY[ctx.action];
  if (actingAgent.authorityLevel < minAuthority) {
    throw new AuthorizationError(
      ctx.actingAgentId,
      ctx.action,
      `requires authority level ${minAuthority}, agent has ${actingAgent.authorityLevel} (${actingAgent.role})`
    );
  }

  // 2. Check hierarchy relationship for target-agent actions
  if (ctx.targetAgentId && ctx.targetAgentId !== ctx.actingAgentId) {
    const needsSubtreeCheck =
      ctx.action === "assign_task" ||
      ctx.action === "reassign_task" ||
      ctx.action === "set_budget" ||
      ctx.action === "send_message_down" ||
      ctx.action === "broadcast";

    // Commander can target anyone, others must target subordinates
    if (
      needsSubtreeCheck &&
      actingAgent.role !== "commander" &&
      !(await isAncestorOf(ctx.actingAgentId, ctx.targetAgentId))
    ) {
      throw new AuthorizationError(
        ctx.actingAgentId,
        ctx.action,
        `target agent ${ctx.targetAgentId} is not in subordinate tree`
      );
    }
  }

  // 3. Check task ownership for cancel/reassign at specialist level
  if (
    ctx.action === "cancel_task" &&
    actingAgent.role === "specialist" &&
    ctx.targetTaskOwnerId &&
    ctx.targetTaskOwnerId !== ctx.actingAgentId
  ) {
    throw new AuthorizationError(
      ctx.actingAgentId,
      ctx.action,
      "specialists can only cancel their own tasks"
    );
  }
}

/**
 * Check authorization without throwing — returns true/false.
 */
export async function isAuthorized(ctx: AuthContext): Promise<boolean> {
  try {
    await assertAuthorized(ctx);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a role promotion request.
 */
export function validatePromotion(
  currentRole: Role,
  newRole: Role,
  requestingRole: Role,
  performanceScore: number,
  tasksCompleted: number
): { valid: boolean; reason?: string } {
  const currentLevel = AUTHORITY_LEVELS[currentRole];
  const newLevel = AUTHORITY_LEVELS[newRole];

  // Promotion to commander requires human approval (not handled here)
  if (newRole === "commander") {
    return { valid: false, reason: "promotion to commander requires human approval" };
  }

  // Only commander can promote
  if (requestingRole !== "commander") {
    return { valid: false, reason: "only commander can promote agents" };
  }

  // Demotion is always allowed by commander
  if (newLevel < currentLevel) {
    return { valid: true };
  }

  // Promotion checks
  if (currentRole === "worker" && newRole === "specialist") {
    if (performanceScore < 0.8) {
      return {
        valid: false,
        reason: `performance score ${performanceScore} < 0.8 required`,
      };
    }
    return { valid: true };
  }

  if (currentRole === "specialist" && newRole === "supervisor") {
    if (tasksCompleted < 20) {
      return {
        valid: false,
        reason: `tasks completed ${tasksCompleted} < 20 required`,
      };
    }
    return { valid: true };
  }

  // Same role — no-op
  if (currentRole === newRole) {
    return { valid: false, reason: "agent already has this role" };
  }

  return { valid: false, reason: `invalid promotion path: ${currentRole} → ${newRole}` };
}
