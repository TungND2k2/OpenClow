import { eq } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { integrations } from "../../db/schema.js";
import { nowMs } from "../../utils/clock.js";
import type { BaseConnector, SendResult } from "./connectors/base.connector.js";
import { webhookConnector } from "./connectors/webhook.connector.js";
import { telegramConnector } from "./connectors/telegram.connector.js";
import { emailConnector } from "./connectors/email.connector.js";

const connectors: Record<string, BaseConnector> = {
  webhook: webhookConnector,
  telegram: telegramConnector,
  email: emailConnector,
};

/**
 * Send a payload through an integration.
 */
export async function sendViaIntegration(
  integrationId: string,
  payload: Record<string, unknown>
): Promise<SendResult> {
  const db = getDb();
  const row = (await db.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1))[0];
  if (!row) return { success: false, error: "Integration not found" };
  if (row.status !== "active") return { success: false, error: `Integration is ${row.status}` };

  const connector = connectors[row.type];
  if (!connector) return { success: false, error: `No connector for type: ${row.type}` };

  const config = row.config as Record<string, unknown>;
  const result = await connector.send(payload, config);

  // Update last_used_at
  await db.update(integrations).set({ lastUsedAt: nowMs() }).where(eq(integrations.id, integrationId));

  // If failed, mark integration as error
  if (!result.success) {
    await db.update(integrations).set({ status: "error" as const, updatedAt: nowMs() }).where(eq(integrations.id, integrationId));
  }

  return result;
}

/**
 * Test an integration.
 */
export async function testIntegration(integrationId: string): Promise<SendResult> {
  const db = getDb();
  const row = (await db.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1))[0];
  if (!row) return { success: false, error: "Integration not found" };

  const connector = connectors[row.type];
  if (!connector) return { success: false, error: `No connector for type: ${row.type}` };

  return connector.test(row.config as Record<string, unknown>);
}

/**
 * Register a custom connector at runtime.
 */
export function registerConnector(type: string, connector: BaseConnector): void {
  connectors[type] = connector;
}
