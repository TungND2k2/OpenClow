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

// ── Conversation Summary ─────────────────────────────────────

const SUMMARY_THRESHOLD = 10; // summarize every N messages
const KEEP_RECENT = 5; // keep last N messages after summary

/**
 * Build optimized history: summary + recent messages + form state.
 * Instead of sending 40+ messages, send: [summary] + [5 recent] = minimal tokens.
 */
export function buildOptimizedHistory(session: ConversationSession): {
  history: { role: string; content: string }[];
  formContext: string;
} {
  const state = session.state ?? { messages: [] };
  const messages = state.messages ?? [];
  const summary = (state as any).summary as string | undefined;
  const formState = (state as any).formState as FormState | undefined;

  const history: { role: string; content: string }[] = [];

  // Inject summary as system context if exists
  if (summary) {
    history.push({ role: "system", content: `[TÓM TẮT HỘI THOẠI TRƯỚC ĐÓ]\n${summary}` });
  }

  // Keep only recent messages
  const recent = messages.slice(-KEEP_RECENT).map((m: ChatMessage) => ({
    role: m.role as string,
    content: m.content as string,
  }));
  history.push(...recent);

  // Build form context if user is filling a form
  let formContext = "";
  if (formState && formState.status === "in_progress") {
    const filled = Object.entries(formState.data)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v], i) => `  ${i + 1}. ${k}: ${v} ✅`)
      .join("\n");
    const pending = formState.pendingFields
      .map((f, i) => `  ${Object.keys(formState.data).length + i + 1}. ${f} ← ${i === 0 ? "ĐANG CHỜ" : "chưa nhập"}`)
      .join("\n");

    formContext = `\nFORM ĐANG NHẬP: "${formState.formName}" (bước ${formState.currentStep}/${formState.totalSteps})
ĐÃ ĐIỀN:
${filled || "  (chưa có)"}
ĐANG CHỜ:
${pending || "  (hoàn thành)"}
→ Hỏi user field tiếp theo. Khi user trả lời → gọi update_form_state để lưu.`;
  }

  return { history, formContext };
}

/**
 * Auto-summarize old messages when history gets long.
 * Called after each appendMessage.
 */
export async function autoSummarize(
  sessionId: string,
  summarizeFn: (messages: string) => Promise<string>,
): Promise<boolean> {
  const db = getDb();
  const session = (await db.select().from(conversationSessions).where(eq(conversationSessions.id, sessionId)).limit(1))[0];
  if (!session) return false;

  let state = session.state as any;
  if (typeof state === "string") {
    try { state = JSON.parse(state); } catch { return false; }
  }
  const messages: ChatMessage[] = state?.messages ?? [];

  // Only summarize if we have enough messages
  if (messages.length < SUMMARY_THRESHOLD + KEEP_RECENT) return false;

  // Messages to summarize (old ones, keep recent)
  const toSummarize = messages.slice(0, -KEEP_RECENT);
  const toKeep = messages.slice(-KEEP_RECENT);

  // Build text for summarization
  const text = toSummarize
    .map((m: ChatMessage) => `${m.role}: ${m.content}`)
    .join("\n");

  // Get existing summary
  const existingSummary = state.summary ?? "";
  const fullText = existingSummary
    ? `[Tóm tắt trước đó]: ${existingSummary}\n\n[Hội thoại mới]:\n${text}`
    : text;

  // Call LLM to summarize
  const summary = await summarizeFn(fullText);

  // Update session: keep summary + recent messages only
  state.summary = summary;
  state.messages = toKeep;

  await db.update(conversationSessions).set({
    state: JSON.stringify(state),
    lastMessageAt: nowMs(),
  }).where(eq(conversationSessions.id, sessionId));

  return true;
}

// ── Form State ───────────────────────────────────────────────

export interface FormState {
  formName: string;
  formTemplateId: string;
  workflowInstanceId?: string;
  status: "in_progress" | "completed" | "cancelled";
  currentStep: number;
  totalSteps: number;
  data: Record<string, unknown>;  // field_name → value
  pendingFields: string[];        // fields not yet filled
  startedAt: number;
}

/**
 * Start a form session — creates form state in conversation.
 */
export async function startFormSession(
  sessionId: string,
  formName: string,
  formTemplateId: string,
  fields: { label: string; required?: boolean }[],
  workflowInstanceId?: string,
): Promise<FormState> {
  const db = getDb();
  const session = (await db.select().from(conversationSessions).where(eq(conversationSessions.id, sessionId)).limit(1))[0];
  if (!session) throw new Error(`Session ${sessionId} not found`);

  let state = session.state as any;
  if (typeof state === "string") {
    try { state = JSON.parse(state); } catch { state = { messages: [] }; }
  }

  const formState: FormState = {
    formName,
    formTemplateId,
    workflowInstanceId,
    status: "in_progress",
    currentStep: 1,
    totalSteps: fields.length,
    data: {},
    pendingFields: fields.map(f => f.label),
    startedAt: Date.now(),
  };

  state.formState = formState;

  await db.update(conversationSessions).set({
    state: JSON.stringify(state),
    lastMessageAt: nowMs(),
  }).where(eq(conversationSessions.id, sessionId));

  return formState;
}

/**
 * Update form field — saves data immediately to DB.
 */
export async function updateFormField(
  sessionId: string,
  fieldName: string,
  value: unknown,
): Promise<FormState> {
  const db = getDb();
  const session = (await db.select().from(conversationSessions).where(eq(conversationSessions.id, sessionId)).limit(1))[0];
  if (!session) throw new Error(`Session ${sessionId} not found`);

  let state = session.state as any;
  if (typeof state === "string") {
    try { state = JSON.parse(state); } catch { state = { messages: [] }; }
  }

  const formState = state.formState as FormState;
  if (!formState) throw new Error("No form in progress");

  // Save field value
  formState.data[fieldName] = value;

  // Remove from pending
  formState.pendingFields = formState.pendingFields.filter(f => f !== fieldName);
  formState.currentStep = formState.totalSteps - formState.pendingFields.length;

  // Check if form is complete
  if (formState.pendingFields.length === 0) {
    formState.status = "completed";
  }

  state.formState = formState;

  await db.update(conversationSessions).set({
    state: JSON.stringify(state),
    lastMessageAt: nowMs(),
  }).where(eq(conversationSessions.id, sessionId));

  return formState;
}

/**
 * Get current form state.
 */
export async function getFormState(sessionId: string): Promise<FormState | null> {
  const session = await getSession(sessionId);
  if (!session) return null;
  return (session.state as any)?.formState ?? null;
}

/**
 * Cancel form session.
 */
export async function cancelFormSession(sessionId: string): Promise<void> {
  const db = getDb();
  const session = (await db.select().from(conversationSessions).where(eq(conversationSessions.id, sessionId)).limit(1))[0];
  if (!session) return;

  let state = session.state as any;
  if (typeof state === "string") {
    try { state = JSON.parse(state); } catch { return; }
  }

  if (state.formState) {
    state.formState.status = "cancelled";
  }

  await db.update(conversationSessions).set({
    state: JSON.stringify(state),
    lastMessageAt: nowMs(),
  }).where(eq(conversationSessions.id, sessionId));
}
