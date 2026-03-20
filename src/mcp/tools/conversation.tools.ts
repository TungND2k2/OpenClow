import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db/connection.js";
import { conversationSessions } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";

export function registerConversationTools(server: McpServer): void {
  server.tool("handle_chat_message", "Process incoming chat message in workflow context", {
    tenant_id: z.string(),
    channel: z.enum(["telegram", "web", "slack"]),
    channel_user_id: z.string(),
    message: z.string(),
    user_name: z.string().optional(),
    user_role: z.string().optional(),
  }, async (params) => {
    const db = getDb();
    const now = nowMs();

    // Find or create session
    let session = (await db.select().from(conversationSessions)
      .where(and(
        eq(conversationSessions.tenantId, params.tenant_id),
        eq(conversationSessions.channel, params.channel),
        eq(conversationSessions.channelUserId, params.channel_user_id),
      )).limit(1))[0];

    if (!session) {
      const id = newId();
      await db.insert(conversationSessions).values({
        id,
        tenantId: params.tenant_id,
        channel: params.channel,
        channelUserId: params.channel_user_id,
        userName: params.user_name ?? null,
        userRole: params.user_role ?? null,
        state: JSON.stringify({ messages: [{ role: "user", content: params.message, at: now }] }),
        lastMessageAt: now,
        createdAt: now,
      });
      session = (await db.select().from(conversationSessions).where(eq(conversationSessions.id, id)).limit(1))[0];
    } else {
      // Append message to state
      const state = (session.state as any) ?? { messages: [] };
      state.messages = state.messages ?? [];
      state.messages.push({ role: "user", content: params.message, at: now });
      await db.update(conversationSessions).set({
        state: JSON.stringify(state),
        lastMessageAt: now,
        userName: params.user_name ?? session.userName,
        userRole: params.user_role ?? session.userRole,
      }).where(eq(conversationSessions.id, session.id));
      session = (await db.select().from(conversationSessions).where(eq(conversationSessions.id, session.id)).limit(1))[0];
    }

    return { content: [{ type: "text", text: JSON.stringify({
      session_id: session!.id,
      active_instance_id: session!.activeInstanceId,
      message_count: ((session!.state as any)?.messages ?? []).length,
    }, null, 2) }] };
  });

  server.tool("get_conversation_session", "Get session state", {
    session_id: z.string(),
  }, async ({ session_id }) => {
    const db = getDb();
    const row = (await db.select().from(conversationSessions).where(eq(conversationSessions.id, session_id)).limit(1))[0];
    if (!row) return { content: [{ type: "text", text: "Not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  });
}
