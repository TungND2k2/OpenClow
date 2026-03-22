import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { agents, agentHierarchy } from "../../db/schema.js";

/**
 * Insert closure table entries when an agent is added to the hierarchy.
 * Creates self-reference (depth 0) + copies ancestor paths from parent.
 */
export async function insertHierarchyEntries(
  agentId: string,
  parentAgentId: string | null
): Promise<void> {
  const db = getDb();

  // Self-reference
  await db.insert(agentHierarchy)
    .values({ ancestorId: agentId, descendantId: agentId, depth: 0 });

  if (parentAgentId) {
    // Copy all ancestors of parent, incrementing depth by 1
    const parentAncestors = await db
      .select({
        ancestorId: agentHierarchy.ancestorId,
        depth: agentHierarchy.depth,
      })
      .from(agentHierarchy)
      .where(eq(agentHierarchy.descendantId, parentAgentId));

    for (const row of parentAncestors) {
      await db.insert(agentHierarchy)
        .values({
          ancestorId: row.ancestorId,
          descendantId: agentId,
          depth: row.depth + 1,
        });
    }
  }
}

/**
 * Remove all closure table entries for an agent.
 * Used before re-parenting.
 */
export async function removeHierarchyEntries(agentId: string): Promise<void> {
  const db = getDb();

  // Get all descendants of this agent (excluding self at depth 0 initially)
  const descendants = await db
    .select({ descendantId: agentHierarchy.descendantId })
    .from(agentHierarchy)
    .where(
      and(
        eq(agentHierarchy.ancestorId, agentId),
        sql`${agentHierarchy.depth} > 0`
      )
    );

  // Remove entries where this agent is a descendant (its ancestor paths)
  await db.delete(agentHierarchy)
    .where(eq(agentHierarchy.descendantId, agentId));

  // For each descendant, remove entries that go through this agent
  // (entries where ancestor is an ancestor of agentId)
  for (const desc of descendants) {
    await db.delete(agentHierarchy)
      .where(
        and(
          eq(agentHierarchy.descendantId, desc.descendantId),
          sql`${agentHierarchy.ancestorId} NOT IN (
            SELECT ancestor_id FROM agent_hierarchy WHERE descendant_id = ${desc.descendantId}
            AND ancestor_id = descendant_id
          )`
        )
      );
  }
}

/**
 * Get all descendants of an agent (agents under their command).
 */
export async function getDescendants(
  agentId: string,
  maxDepth?: number
): Promise<{ descendantId: string; depth: number }[]> {
  const db = getDb();

  const conditions = [
    eq(agentHierarchy.ancestorId, agentId),
    sql`${agentHierarchy.depth} > 0`,
  ];

  if (maxDepth !== undefined) {
    conditions.push(sql`${agentHierarchy.depth} <= ${maxDepth}`);
  }

  return await db
    .select({
      descendantId: agentHierarchy.descendantId,
      depth: agentHierarchy.depth,
    })
    .from(agentHierarchy)
    .where(and(...conditions));
}

/**
 * Get all ancestors of an agent (chain of command up to Commander).
 */
export async function getAncestors(
  agentId: string
): Promise<{ ancestorId: string; depth: number }[]> {
  const db = getDb();
  return await db
    .select({
      ancestorId: agentHierarchy.ancestorId,
      depth: agentHierarchy.depth,
    })
    .from(agentHierarchy)
    .where(
      and(
        eq(agentHierarchy.descendantId, agentId),
        sql`${agentHierarchy.depth} > 0`
      )
    )
    .orderBy(agentHierarchy.depth);
}

/**
 * Check if ancestor is actually an ancestor of descendant.
 */
export async function isAncestorOf(
  ancestorId: string,
  descendantId: string
): Promise<boolean> {
  const db = getDb();
  const row = (await db
    .select({ depth: agentHierarchy.depth })
    .from(agentHierarchy)
    .where(
      and(
        eq(agentHierarchy.ancestorId, ancestorId),
        eq(agentHierarchy.descendantId, descendantId),
        sql`${agentHierarchy.depth} > 0`
      )
    )
    .limit(1))[0];
  return row !== undefined;
}

/**
 * Get direct children (depth = 1) of an agent.
 */
export async function getDirectChildren(agentId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ descendantId: agentHierarchy.descendantId })
    .from(agentHierarchy)
    .where(
      and(
        eq(agentHierarchy.ancestorId, agentId),
        eq(agentHierarchy.depth, 1)
      )
    );
  return rows.map((r) => r.descendantId);
}

/**
 * Count direct children of an agent.
 */
export async function countDirectChildren(agentId: string): Promise<number> {
  const db = getDb();
  const row = (await db
    .select({ count: sql<number>`count(*)` })
    .from(agentHierarchy)
    .where(
      and(
        eq(agentHierarchy.ancestorId, agentId),
        eq(agentHierarchy.depth, 1)
      )
    ))[0];
  return row?.count ?? 0;
}
