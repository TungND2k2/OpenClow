import { eq, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { conversationSessions } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  at: number;
}

export interface ConversationSession {
  id: string;
  tenantId: string;
  channel: string;
  channelUserId: string;
  userName: string | null;
  userRole: string | null;
  activeInstanceId: string | null;
  state: { messages: ChatMessage[]; [key: string]: unknown };
  lastMessageAt: number;
  createdAt: number;
}

function toSession(row: any): ConversationSession {
  let state = row.state;
  if (typeof state === "string") {
    try { state = JSON.parse(state); } catch { state = { messages: [] }; }
  }
  return { ...row, state: state ?? { messages: [] } };
}

/**
 * Find or create a conversation session.
 */
export async function getOrCreateSession(input: {
  tenantId: string;
  channel: "telegram" | "web" | "slack";
  channelUserId: string;
  userName?: string;
  userRole?: string;
}): Promise<ConversationSession> {
  const db = getDb();

  const existing = (await db.select().from(conversationSessions).where(
    and(
      eq(conversationSessions.tenantId, input.tenantId),
      eq(conversationSessions.channel, input.channel),
      eq(conversationSessions.channelUserId, input.channelUserId),
    )
  ).limit(1))[0];

  if (existing) return toSession(existing);

  const now = nowMs();
  const id = newId();
  await db.insert(conversationSessions).values({
    id,
    tenantId: input.tenantId,
    channel: input.channel,
    channelUserId: input.channelUserId,
    userName: input.userName ?? null,
    userRole: input.userRole ?? null,
    state: JSON.stringify({ messages: [] }),
    lastMessageAt: now,
    createdAt: now,
  });

  return toSession((await db.select().from(conversationSessions).where(eq(conversationSessions.id, id)).limit(1))[0]!);
}

/**
 * Append a message to session.
 */
export async function appendMessage(sessionId: string, message: ChatMessage): Promise<ConversationSession> {
  const db = getDb();
  const now = nowMs();
  const session = (await db.select().from(conversationSessions).where(eq(conversationSessions.id, sessionId)).limit(1))[0];
  if (!session) throw new Error(`Session ${sessionId} not found`);

  let state = session.state as any;
  if (typeof state === "string") {
    try { state = JSON.parse(state); } catch { state = { messages: [] }; }
  }
  state = state ?? { messages: [] };
  state.messages = state.messages ?? [];
  state.messages.push(message);

  await db.update(conversationSessions).set({
    state: JSON.stringify(state),
    lastMessageAt: now,
  }).where(eq(conversationSessions.id, sessionId));

  return toSession((await db.select().from(conversationSessions).where(eq(conversationSessions.id, sessionId)).limit(1))[0]!);
}

/**
 * Link session to a workflow instance.
 */
export async function linkToWorkflow(sessionId: string, instanceId: string): Promise<void> {
  const db = getDb();
  await db.update(conversationSessions).set({
    activeInstanceId: instanceId,
  }).where(eq(conversationSessions.id, sessionId));
}

/**
 * Get session by ID.
 */
export async function getSession(sessionId: string): Promise<ConversationSession | null> {
  const db = getDb();
  const row = (await db.select().from(conversationSessions).where(eq(conversationSessions.id, sessionId)).limit(1))[0];
  return row ? toSession(row) : null;
}
