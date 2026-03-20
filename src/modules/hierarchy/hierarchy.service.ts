import { eq } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { agents } from "../../db/schema.js";
import {
  insertHierarchyEntries,
  removeHierarchyEntries,
  getDescendants,
  getAncestors,
  getDirectChildren,
  countDirectChildren,
  isAncestorOf,
} from "./hierarchy.queries.js";
import {
  type Role,
  type HierarchyNode,
  AUTHORITY_LEVELS,
  MAX_SUBORDINATES,
} from "./hierarchy.types.js";
import { assertAuthorized } from "./authorization.js";
import { validatePromotion } from "./authorization.js";

/**
 * Set the parent (supervisor) of an agent in the hierarchy.
 */
export async function setAgentParent(
  agentId: string,
  parentAgentId: string
): Promise<void> {
  const db = getDb();

  const agent = (await db
    .select({ id: agents.id, role: agents.role })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1))[0];
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const parent = (await db
    .select({
      id: agents.id,
      role: agents.role,
      authorityLevel: agents.authorityLevel,
    })
    .from(agents)
    .where(eq(agents.id, parentAgentId))
    .limit(1))[0];
  if (!parent) throw new Error(`Parent agent ${parentAgentId} not found`);

  // Parent must have higher authority
  const agentLevel = AUTHORITY_LEVELS[agent.role as Role];
  if (parent.authorityLevel <= agentLevel) {
    throw new Error(
      `Parent ${parentAgentId} (${parent.role}) must have higher authority than ${agentId} (${agent.role})`
    );
  }

  // Check max subordinates
  const currentCount = await countDirectChildren(parentAgentId);
  const maxSubs = MAX_SUBORDINATES[parent.role as Role];
  if (currentCount >= maxSubs) {
    throw new Error(
      `Parent ${parentAgentId} (${parent.role}) already has ${currentCount}/${maxSubs} subordinates`
    );
  }

  // Prevent circular: parent cannot be a descendant of agent
  if (await isAncestorOf(agentId, parentAgentId)) {
    throw new Error(
      `Cannot set ${parentAgentId} as parent of ${agentId}: would create circular hierarchy`
    );
  }

  // Remove old hierarchy entries and re-insert
  await removeHierarchyEntries(agentId);

  // Update agent record
  await db.update(agents)
    .set({ parentAgentId })
    .where(eq(agents.id, agentId));

  // Re-insert hierarchy entries with new parent
  await insertHierarchyEntries(agentId, parentAgentId);

  // Re-attach existing children
  const children = await getDirectChildren(agentId);
  for (const childId of children) {
    await removeHierarchyEntries(childId);
    await insertHierarchyEntries(childId, agentId);
  }
}

/**
 * Promote or demote an agent.
 */
export async function promoteAgent(
  agentId: string,
  newRole: Role,
  requestingAgentId: string
): Promise<void> {
  const db = getDb();

  // Check requesting agent is authorized
  await assertAuthorized({
    actingAgentId: requestingAgentId,
    action: "promote_agent",
    targetAgentId: agentId,
  });

  const agent = (await db
    .select({
      role: agents.role,
      performanceScore: agents.performanceScore,
      tasksCompleted: agents.tasksCompleted,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1))[0];
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const requestingAgent = (await db
    .select({ role: agents.role })
    .from(agents)
    .where(eq(agents.id, requestingAgentId))
    .limit(1))[0];
  if (!requestingAgent) {
    throw new Error(`Requesting agent ${requestingAgentId} not found`);
  }

  const validation = validatePromotion(
    agent.role as Role,
    newRole,
    requestingAgent.role as Role,
    agent.performanceScore,
    agent.tasksCompleted
  );

  if (!validation.valid) {
    throw new Error(`Cannot promote ${agentId}: ${validation.reason}`);
  }

  const newLevel = AUTHORITY_LEVELS[newRole];

  await db.update(agents)
    .set({
      role: newRole,
      authorityLevel: newLevel,
      updatedAt: Date.now(),
    })
    .where(eq(agents.id, agentId));
}

/**
 * Get all subordinates of an agent with their info.
 */
export async function getSubordinates(
  agentId: string,
  depth?: number
): Promise<{
  id: string;
  name: string;
  role: string;
  status: string;
  depth: number;
}[]> {
  const db = getDb();
  const descendants = await getDescendants(agentId, depth);
  if (descendants.length === 0) return [];

  const ids = descendants.map((d) => d.descendantId);
  const depthMap = new Map(
    descendants.map((d) => [d.descendantId, d.depth])
  );

  const agentRows = (await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      status: agents.status,
    })
    .from(agents))
    .filter((a) => ids.includes(a.id));

  return agentRows.map((a) => ({
    ...a,
    depth: depthMap.get(a.id) ?? 0,
  }));
}

/**
 * Get the chain of command from agent up to Commander.
 */
export async function getChainOfCommand(
  agentId: string
): Promise<{ id: string; name: string; role: string; depth: number }[]> {
  const db = getDb();
  const ancestors = await getAncestors(agentId);
  if (ancestors.length === 0) return [];

  const ids = ancestors.map((a) => a.ancestorId);
  const depthMap = new Map(
    ancestors.map((a) => [a.ancestorId, a.depth])
  );

  const agentRows = (await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
    })
    .from(agents))
    .filter((a) => ids.includes(a.id));

  return agentRows
    .map((a) => ({
      ...a,
      depth: depthMap.get(a.id) ?? 0,
    }))
    .sort((a, b) => a.depth - b.depth);
}

/**
 * Build the full hierarchy tree starting from Commander.
 */
export async function getHierarchyTree(): Promise<HierarchyNode[]> {
  const db = getDb();

  const allAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      authorityLevel: agents.authorityLevel,
      status: agents.status,
      parentAgentId: agents.parentAgentId,
    })
    .from(agents);

  // Build lookup
  const byId = new Map<string, (typeof allAgents)[number]>();
  const childrenOf = new Map<string | null, string[]>();

  for (const agent of allAgents) {
    byId.set(agent.id, agent);
    const parentKey = agent.parentAgentId;
    if (!childrenOf.has(parentKey)) {
      childrenOf.set(parentKey, []);
    }
    childrenOf.get(parentKey)!.push(agent.id);
  }

  function buildNode(
    agentId: string,
    depth: number
  ): HierarchyNode {
    const agent = byId.get(agentId)!;
    const childIds = childrenOf.get(agentId) ?? [];
    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.role as Role,
      authorityLevel: agent.authorityLevel,
      status: agent.status as any,
      parentAgentId: agent.parentAgentId,
      depth,
      children: childIds.map((cid) => buildNode(cid, depth + 1)),
    };
  }

  // Root nodes = agents with no parent
  const rootIds = childrenOf.get(null) ?? [];
  return rootIds.map((id) => buildNode(id, 0));
}
