import { sql } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db/connection.js";
import { tasks } from "../../db/schema.js";

export function registerTaskResources(server: McpServer): void {
  server.resource("task-board", "openclaw://tasks/board", async () => {
    const db = getDb();
    const byStatus = await db.select({
      status: tasks.status,
      count: sql<number>`count(*)`,
    }).from(tasks).groupBy(tasks.status);

    return {
      contents: [{
        uri: "openclaw://tasks/board",
        mimeType: "application/json",
        text: JSON.stringify({ taskBoard: byStatus }, null, 2),
      }],
    };
  });
}
