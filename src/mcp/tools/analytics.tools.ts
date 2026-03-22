import { z } from "zod";
import { sql, and, eq } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db/connection.js";
import { tasks, tokenUsage } from "../../db/schema.js";

export function registerAnalyticsTools(server: McpServer): void {
  server.tool("get_task_metrics", "Aggregate task metrics", {
    agent_id: z.string().optional(),
    time_range_start: z.number().optional(),
    time_range_end: z.number().optional(),
  }, async (params) => {
    const db = getDb();
    const conditions: any[] = [];
    if (params.agent_id) conditions.push(eq(tasks.assignedAgentId, params.agent_id));
    if (params.time_range_start) conditions.push(sql`${tasks.createdAt} >= ${params.time_range_start}`);
    if (params.time_range_end) conditions.push(sql`${tasks.createdAt} <= ${params.time_range_end}`);

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const total = (await db.select({ count: sql<number>`count(*)` }).from(tasks).where(where))[0];
    const byStatus = await db.select({
      status: tasks.status,
      count: sql<number>`count(*)`,
    }).from(tasks).where(where).groupBy(tasks.status);

    const avgDuration = (await db.select({
      avg: sql<number>`avg(${tasks.completedAt} - ${tasks.startedAt})`,
    }).from(tasks).where(
      and(
        ...(conditions.length ? conditions : []),
        sql`${tasks.completedAt} IS NOT NULL AND ${tasks.startedAt} IS NOT NULL`
      )
    ))[0];

    return { content: [{ type: "text", text: JSON.stringify({
      total: total?.count ?? 0,
      byStatus,
      avgDurationMs: avgDuration?.avg ?? null,
    }, null, 2) }] };
  });

  server.tool("get_cost_report", "Token usage and cost breakdown", {
    agent_id: z.string().optional(),
    time_range_start: z.number().optional(),
    time_range_end: z.number().optional(),
    group_by: z.enum(["agent", "model", "task"]).optional(),
  }, async (params) => {
    const db = getDb();
    const conditions: any[] = [];
    if (params.agent_id) conditions.push(eq(tokenUsage.agentId, params.agent_id));
    if (params.time_range_start) conditions.push(sql`${tokenUsage.createdAt} >= ${params.time_range_start}`);
    if (params.time_range_end) conditions.push(sql`${tokenUsage.createdAt} <= ${params.time_range_end}`);

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totals = (await db.select({
      totalCost: sql<number>`COALESCE(SUM(${tokenUsage.costUsd}), 0)`,
      totalInput: sql<number>`COALESCE(SUM(${tokenUsage.inputTokens}), 0)`,
      totalOutput: sql<number>`COALESCE(SUM(${tokenUsage.outputTokens}), 0)`,
      count: sql<number>`count(*)`,
    }).from(tokenUsage).where(where))[0];

    let breakdown: any[] = [];
    if (params.group_by === "agent") {
      breakdown = await db.select({
        agentId: tokenUsage.agentId,
        cost: sql<number>`SUM(${tokenUsage.costUsd})`,
        requests: sql<number>`count(*)`,
      }).from(tokenUsage).where(where).groupBy(tokenUsage.agentId);
    } else if (params.group_by === "model") {
      breakdown = await db.select({
        model: tokenUsage.model,
        cost: sql<number>`SUM(${tokenUsage.costUsd})`,
        requests: sql<number>`count(*)`,
      }).from(tokenUsage).where(where).groupBy(tokenUsage.model);
    }

    return { content: [{ type: "text", text: JSON.stringify({ ...totals, breakdown }, null, 2) }] };
  });
}
