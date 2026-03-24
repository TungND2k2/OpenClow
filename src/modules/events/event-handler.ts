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
  if (subs.length === 0) return;

  console.error(`[EventHandler] ${event.type}:${event.collection ?? ""} → ${subs.length} subscriptions matched`);

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

      console.error(`[EventHandler] Trigger ${sub.agentName}: "${message.substring(0, 80)}..."`);

      if (_triggerAgentCallback) {
        // Fire async — don't block
        _triggerAgentCallback(event.tenantId, `[AUTO] ${sub.agentName}: ${message}`, context)
          .catch(e => console.error(`[EventHandler] Trigger failed: ${e.message}`));
      }
    } catch (e: any) {
      console.error(`[EventHandler] Error processing subscription ${sub.id}: ${e.message}`);
    }
  }
}
