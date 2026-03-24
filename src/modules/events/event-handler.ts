/**
 * Event Handler — processes events by triggering agent actions.
 *
 * When data changes → event emitted → matching subscriptions found →
 * inject prompt into pipeline → agent responds in Telegram.
 *
 * Runs ASYNC — doesn't block the original request.
 */

import { getMatchingSubscriptions, type AgentEvent } from "./event-bus.js";

// Callback set by telegram.bot.ts — injects message into bot pipeline
let _triggerAgentCallback: ((tenantId: string, message: string, context?: string) => Promise<void>) | null = null;

/**
 * Set the callback for triggering agent messages.
 * Called once by telegram.bot.ts during initialization.
 */
export function setAgentTrigger(cb: (tenantId: string, message: string, context?: string) => Promise<void>): void {
  _triggerAgentCallback = cb;
}

/**
 * Handle an event — find matching subscriptions and trigger agents.
 */
export async function handleEvent(event: AgentEvent): Promise<void> {
  const subs = getMatchingSubscriptions(event);

  console.error(`[EventBus] Event: ${event.type}:${event.collection ?? ""} | by: ${event.triggeredBy ?? "system"} | data: ${JSON.stringify(event.data ?? {}).substring(0, 100)}`);
  console.error(`[EventBus] Subscriptions checked: ${subs.length} matched (tenant: ${event.tenantId.substring(0, 8)})`);

  if (subs.length === 0) {
    console.error(`[EventBus] No subscriptions → skip`);
    return;
  }

  for (const s of subs) {
    console.error(`[EventBus]   → ${s.agentName} (pattern: "${s.eventPattern}")`);
  }

  for (const sub of subs) {
    try {
      // Build context from event data
      const context = JSON.stringify({
        event: event.type,
        collection: event.collection,
        rowId: event.rowId,
        data: event.data,
        changedFields: event.changedFields,
        triggeredBy: event.triggeredBy,
      });

      // Inject as agent message — action template + event data
      const message = sub.action
        .replace("{{collection}}", event.collection ?? "")
        .replace("{{rowId}}", event.rowId ?? "")
        .replace("{{data}}", JSON.stringify(event.data ?? {}))
        .replace("{{changedFields}}", (event.changedFields ?? []).join(", "))
        .replace("{{triggeredBy}}", event.triggeredBy ?? "system");

      console.error(`[EventBus] Trigger → ${sub.agentName}: "${message.substring(0, 100)}"`);

      if (_triggerAgentCallback) {
        console.error(`[EventBus] Injecting into pipeline...`);
        _triggerAgentCallback(event.tenantId, `[AUTO] ${sub.agentName}: ${message}`, context)
          .then(() => console.error(`[EventBus] ✓ ${sub.agentName} pipeline complete`))
          .catch(e => console.error(`[EventBus] ✗ ${sub.agentName} failed: ${e.message}`));
      } else {
        console.error(`[EventBus] ⚠️ No trigger callback set — agent message not injected`);
      }
    } catch (e: any) {
      console.error(`[EventHandler] Error processing subscription ${sub.id}: ${e.message}`);
    }
  }
}
