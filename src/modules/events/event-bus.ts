/**
 * Event Bus — data change triggers agent actions.
 *
 * Flow:
 *   1. Tool mutates data (add_row, update_row, etc.)
 *   2. Tool emits event: { type: "row.created", collection: "orders", data: {...} }
 *   3. Event bus checks agent_subscriptions: which agents listen to this event?
 *   4. For each matching agent → inject message into pipeline as if user sent it
 *   5. Agent processes → responds in Telegram chat
 *
 * Events are per-tenant. Agents only see events from their tenant.
 */

import { getDb } from "../../db/connection.js";
import { sql } from "drizzle-orm";

// ── Types ────────────────────────────────────────────────

export interface AgentEvent {
  type: string;              // "row.created", "row.updated", "row.deleted", "file.uploaded", "form.completed"
  tenantId: string;
  collection?: string;       // collection name/slug
  rowId?: string;
  data?: Record<string, unknown>;
  changedFields?: string[];  // for updates: which fields changed
  triggeredBy?: string;      // user who caused the event
  timestamp: number;
}

export interface EventSubscription {
  id: string;
  tenantId: string;
  agentTemplateId: string;
  agentName: string;
  eventPattern: string;      // "row.created:orders", "row.updated:orders:status", "*"
  action: string;            // prompt to inject when event fires
  isActive: boolean;
}

type EventHandler = (event: AgentEvent) => Promise<void>;

// ── In-memory subscribers ────────────────────────────────

const _handlers: EventHandler[] = [];
const _subscriptions: Map<string, EventSubscription[]> = new Map(); // tenantId → subs

/**
 * Register a global event handler (for pipeline integration).
 */
export function onEvent(handler: EventHandler): void {
  _handlers.push(handler);
}

/**
 * Emit an event — notifies all matching handlers + agent subscriptions.
 */
export async function emitEvent(event: AgentEvent): Promise<void> {
  console.error(`[EventBus] ${event.type}${event.collection ? `:${event.collection}` : ""} (tenant: ${event.tenantId.substring(0, 8)})`);

  // Notify global handlers
  for (const handler of _handlers) {
    try {
      await handler(event);
    } catch (e: any) {
      console.error(`[EventBus] Handler error: ${e.message}`);
    }
  }
}

/**
 * Load agent subscriptions from DB for a tenant.
 */
export async function loadSubscriptions(tenantId: string): Promise<EventSubscription[]> {
  const db = getDb();
  const rows = await db.select().from(sql`agent_subscriptions`)
    .where(sql`tenant_id = ${tenantId} AND is_active = true`);

  const subs = (rows as any[]).map(r => ({
    id: r.id,
    tenantId: r.tenant_id,
    agentTemplateId: r.agent_template_id,
    agentName: r.agent_name,
    eventPattern: r.event_pattern,
    action: r.action,
    isActive: r.is_active,
  }));

  _subscriptions.set(tenantId, subs);
  return subs;
}

/**
 * Get subscriptions matching an event.
 */
export function getMatchingSubscriptions(event: AgentEvent): EventSubscription[] {
  const subs = _subscriptions.get(event.tenantId) ?? [];

  return subs.filter(sub => {
    const pattern = sub.eventPattern;

    // Wildcard — matches everything
    if (pattern === "*") return true;

    // Exact match: "row.created:orders"
    const eventKey = `${event.type}${event.collection ? `:${event.collection}` : ""}`;
    if (pattern === eventKey) return true;

    // Prefix match: "row.updated:orders" matches "row.updated:orders:status"
    if (eventKey.startsWith(pattern)) return true;

    // Field-specific: "row.updated:orders:status" → only when status field changed
    const parts = pattern.split(":");
    if (parts.length === 3 && event.changedFields) {
      const [evtType, col, field] = parts;
      if (event.type === evtType && event.collection === col && event.changedFields.includes(field)) {
        return true;
      }
    }

    return false;
  });
}

/**
 * Create a subscription (agent subscribes to event pattern).
 */
export async function createSubscription(input: {
  tenantId: string;
  agentTemplateId: string;
  agentName: string;
  eventPattern: string;
  action: string;
}): Promise<EventSubscription> {
  const db = getDb();
  const { newId } = await import("../../utils/id.js");
  const id = newId();

  await db.execute(sql`
    INSERT INTO agent_subscriptions (id, tenant_id, agent_template_id, agent_name, event_pattern, action, is_active, created_at)
    VALUES (${id}, ${input.tenantId}, ${input.agentTemplateId}, ${input.agentName}, ${input.eventPattern}, ${input.action}, true, ${Date.now()})
  `);

  // Refresh cache
  await loadSubscriptions(input.tenantId);

  const sub: EventSubscription = { ...input, id, isActive: true };
  console.error(`[EventBus] Subscription created: ${input.agentName} → ${input.eventPattern}`);
  return sub;
}

/**
 * List all subscriptions for a tenant.
 */
export async function listSubscriptions(tenantId: string): Promise<EventSubscription[]> {
  let subs = _subscriptions.get(tenantId);
  if (!subs) subs = await loadSubscriptions(tenantId);
  return subs;
}

/**
 * Delete a subscription.
 */
export async function deleteSubscription(id: string, tenantId: string): Promise<void> {
  const db = getDb();
  await db.execute(sql`UPDATE agent_subscriptions SET is_active = false WHERE id = ${id}`);
  await loadSubscriptions(tenantId);
}
