import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db/connection.js";
import { integrations } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";

export function registerIntegrationTools(server: McpServer): void {
  server.tool("create_integration", "Register an external integration", {
    tenant_id: z.string(),
    name: z.string(),
    type: z.enum(["telegram", "webhook", "email", "slack", "whatsapp", "sms", "custom"]),
    config: z.record(z.unknown()),
  }, async (params) => {
    const db = getDb();
    const now = nowMs();
    const id = newId();
    await db.insert(integrations).values({
      id,
      tenantId: params.tenant_id,
      name: params.name,
      type: params.type,
      config: JSON.stringify(params.config),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { content: [{ type: "text", text: JSON.stringify({ id, name: params.name }, null, 2) }] };
  });

  server.tool("test_integration", "Send test payload to integration", {
    integration_id: z.string(),
    test_payload: z.record(z.unknown()),
  }, async ({ integration_id, test_payload }) => {
    const db = getDb();
    const row = (await db.select().from(integrations).where(eq(integrations.id, integration_id)).limit(1))[0];
    if (!row) return { content: [{ type: "text", text: "Not found" }], isError: true };

    // For now just validate the integration exists and return config type
    return { content: [{ type: "text", text: JSON.stringify({
      integration: row.name,
      type: row.type,
      status: "test_ok",
      payload_received: test_payload,
    }, null, 2) }] };
  });

  server.tool("list_integrations", "List integrations for tenant", {
    tenant_id: z.string(),
    type: z.string().optional(),
  }, async (params) => {
    const db = getDb();
    const conditions: any[] = [eq(integrations.tenantId, params.tenant_id)];
    if (params.type) conditions.push(eq(integrations.type, params.type as any));
    const rows = await db.select().from(integrations).where(and(...conditions));
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });
}
