import { z } from "zod";
import { eq, and, sql, desc } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db/connection.js";
import { knowledgeEntries, knowledgeVotes } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";

export function registerKnowledgeTools(server: McpServer): void {
  server.tool("store_knowledge", "Store a knowledge entry", {
    type: z.enum(["lesson_learned", "best_practice", "anti_pattern", "domain_knowledge", "procedure"]),
    title: z.string(),
    content: z.string(),
    domain: z.string(),
    tags: z.array(z.string()),
    scope: z.string().optional(),
    source_task_id: z.string().optional(),
    agent_id: z.string(),
  }, async (params) => {
    const db = getDb();
    const now = nowMs();
    const id = newId();
    await db.insert(knowledgeEntries).values({
      id,
      type: params.type,
      title: params.title,
      content: params.content,
      domain: params.domain,
      tags: JSON.stringify(params.tags),
      scope: params.scope ?? "global",
      sourceTaskId: params.source_task_id ?? null,
      sourceAgentId: params.agent_id,
      relevanceScore: 0.5,
      confidence: 0.5,
      usageCount: 0,
      upvotes: 0,
      downvotes: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { content: [{ type: "text", text: JSON.stringify({ id, title: params.title }, null, 2) }] };
  });

  server.tool("query_knowledge", "Retrieve relevant knowledge", {
    domain: z.string().optional(),
    tags: z.array(z.string()).optional(),
    scope: z.string().optional(),
    limit: z.number().optional(),
  }, async (params) => {
    const db = getDb();
    const conditions: any[] = [sql`${knowledgeEntries.supersededById} IS NULL`];
    if (params.domain) conditions.push(eq(knowledgeEntries.domain, params.domain));
    if (params.scope) conditions.push(eq(knowledgeEntries.scope, params.scope));

    const rows = await db.select().from(knowledgeEntries)
      .where(and(...conditions))
      .orderBy(desc(knowledgeEntries.relevanceScore))
      .limit(params.limit ?? 10);

    let result = rows;
    if (params.tags && params.tags.length > 0) {
      result = rows.filter((r) => {
        const t = (r.tags as unknown as string[]) ?? [];
        return params.tags!.some((tag) => t.includes(tag));
      });
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("vote_knowledge", "Upvote or downvote a knowledge entry", {
    knowledge_id: z.string(),
    agent_id: z.string(),
    vote: z.number().describe("+1 or -1"),
    comment: z.string().optional(),
  }, async (params) => {
    const db = getDb();
    const now = nowMs();
    const id = newId();
    try {
      await db.insert(knowledgeVotes).values({
        id,
        knowledgeId: params.knowledge_id,
        agentId: params.agent_id,
        vote: params.vote,
        comment: params.comment ?? null,
        createdAt: now,
      });
      // Update counts
      const field = params.vote > 0 ? "upvotes" : "downvotes";
      await db.execute(sql`UPDATE knowledge_entries SET ${sql.raw(field)} = ${sql.raw(field)} + 1 WHERE id = ${params.knowledge_id}`);
      return { content: [{ type: "text", text: "Vote recorded" }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  });

  server.tool("get_knowledge", "Get single knowledge entry", {
    knowledge_id: z.string(),
  }, async ({ knowledge_id }) => {
    const db = getDb();
    const row = (await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, knowledge_id)).limit(1))[0];
    if (!row) return { content: [{ type: "text", text: "Not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  });

  server.tool("supersede_knowledge", "Mark entry as replaced", {
    old_knowledge_id: z.string(),
    new_knowledge_id: z.string(),
    agent_id: z.string(),
  }, async ({ old_knowledge_id, new_knowledge_id }) => {
    const db = getDb();
    await db.update(knowledgeEntries)
      .set({ supersededById: new_knowledge_id, updatedAt: nowMs() })
      .where(eq(knowledgeEntries.id, old_knowledge_id));
    return { content: [{ type: "text", text: "OK" }] };
  });

  server.tool("get_knowledge_stats", "Knowledge base statistics", {
    domain: z.string().optional(),
  }, async (params) => {
    const db = getDb();
    const conditions: any[] = [];
    if (params.domain) conditions.push(eq(knowledgeEntries.domain, params.domain));

    const total = (await db.select({ count: sql<number>`count(*)` })
      .from(knowledgeEntries)
      .where(conditions.length ? and(...conditions) : undefined))[0];

    const byType = await db.select({
      type: knowledgeEntries.type,
      count: sql<number>`count(*)`,
    }).from(knowledgeEntries)
      .where(conditions.length ? and(...conditions) : undefined)
      .groupBy(knowledgeEntries.type);

    return { content: [{ type: "text", text: JSON.stringify({ total: total?.count ?? 0, byType }, null, 2) }] };
  });
}
