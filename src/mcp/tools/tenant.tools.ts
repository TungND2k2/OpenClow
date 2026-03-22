import { z } from "zod";
import { eq } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db/connection.js";
import { tenants } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";

export function registerTenantTools(server: McpServer): void {
  server.tool("create_tenant", "Create a new business tenant", {
    name: z.string(),
    config: z.record(z.unknown()).optional(),
    ai_config: z.record(z.unknown()).optional(),
  }, async (params) => {
    const db = getDb();
    const now = nowMs();
    const id = newId();
    await db.insert(tenants).values({
      id,
      name: params.name,
      config: params.config ? JSON.stringify(params.config) : "{}",
      aiConfig: params.ai_config ? JSON.stringify(params.ai_config) : "{}",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { content: [{ type: "text", text: JSON.stringify({ id, name: params.name }, null, 2) }] };
  });

  server.tool("get_tenant", "Get tenant details", {
    tenant_id: z.string(),
  }, async ({ tenant_id }) => {
    const db = getDb();
    const row = (await db.select().from(tenants).where(eq(tenants.id, tenant_id)).limit(1))[0];
    if (!row) return { content: [{ type: "text", text: "Not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  });

  server.tool("update_tenant", "Update tenant config", {
    tenant_id: z.string(),
    config: z.record(z.unknown()).optional(),
    ai_config: z.record(z.unknown()).optional(),
    status: z.enum(["active", "suspended", "archived"]).optional(),
  }, async (params) => {
    const db = getDb();
    const updates: Record<string, any> = { updatedAt: nowMs() };
    if (params.config) updates.config = JSON.stringify(params.config);
    if (params.ai_config) updates.aiConfig = JSON.stringify(params.ai_config);
    if (params.status) updates.status = params.status;
    await db.update(tenants).set(updates).where(eq(tenants.id, params.tenant_id));
    return { content: [{ type: "text", text: "OK" }] };
  });
}
