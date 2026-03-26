/**
 * Pipeline — middleware-based orchestrator for the Commander agent.
 *
 * Replaces the monolithic processWithCommander() with a clean pipeline:
 *   feedback → knowledge → context → route → execute → learn
 */

import { getCommander } from "../modules/agents/agent-pool.js";
import { heartbeat, updatePerformance } from "../modules/agents/agent.service.js";
import { createTask, assignTask, startTask, completeTask, failTask } from "../modules/tasks/task.service.js";
import { storeKnowledge } from "../modules/knowledge/knowledge.service.js";
import { recordDecision } from "../modules/decisions/decision.service.js";
import { botLog } from "../modules/logs/bot-logger.js";
import * as log from "./middleware/logger.js";

import { feedbackMiddleware } from "./middleware/01-feedback.js";
import { knowledgeMiddleware } from "./middleware/02-knowledge.js";
import { contextMiddleware } from "./middleware/03-context.js";
import { routeMiddleware } from "./middleware/04-route.js";
import { executeMiddleware } from "./middleware/05-execute.js";
import { learnMiddleware } from "./middleware/06-learn.js";
import type { PipelineContext } from "./middleware/types.js";

// Track last tools called per session — for feedback detection (shared across requests)
const _lastToolsCalledBySession = new Map<string, string[]>();

const middlewares = [
  feedbackMiddleware,
  knowledgeMiddleware,
  contextMiddleware,
  routeMiddleware,
  executeMiddleware,
  learnMiddleware,
];

export interface PersonaMsg {
  emoji: string;
  name: string;
  content: string;
}

export interface CommanderResponse {
  text: string;
  files: { url: string; fileName: string; mimeType: string }[];
  personaMessages?: PersonaMsg[];
}

export async function processWithCommander(input: {
  userMessage: string;
  userName: string;
  userId: string;
  userRole: string;
  tenantId: string;
  tenantName: string;
  conversationHistory: { role: string; content: string }[];
  aiConfig: Record<string, unknown>;
  onProgress?: (stage: string) => Promise<void>;
  onPersonaMessage?: (msg: PersonaMsg) => Promise<void>;
  sessionId?: string;
}): Promise<CommanderResponse> {
  const startTime = Date.now();

  console.error(`[Pipeline] ─── START ───────────────────────────`);
  console.error(`[Pipeline] User: ${input.userName} (${input.userRole})`);
  console.error(`[Pipeline] Message: "${input.userMessage}"`);
  console.error(`[Pipeline] Tenant: ${input.tenantId}`);
  console.error(`[Pipeline] History: ${input.conversationHistory.length} messages`);

  // ── Get Commander agent ──────────────────────────────────
  const commander = getCommander();
  if (!commander) {
    return { text: "⚠️ Commander agent chưa khởi tạo. Restart hệ thống.", files: [] };
  }

  const commanderAgentId = commander.agent.id;
  await heartbeat(commanderAgentId);

  // ── Create Task (valid FK to Commander) ──────────────────
  let taskId: string | null = null;
  try {
    const task = await createTask({
      title: `Chat: ${input.userMessage.substring(0, 50)}`,
      description: input.userMessage,
      tags: ["chat", "telegram"],
      createdByAgentId: commanderAgentId,
    });
    await assignTask(task.id, commanderAgentId, commanderAgentId);
    await startTask(task.id, commanderAgentId);
    taskId = task.id;
    console.error(`[Pipeline] Task: ${task.id} → Commander (${commander.agent.name})`);
  } catch (taskErr: any) {
    console.error(`[Pipeline] Task creation skipped: ${taskErr.message}`);
  }

  // ── Build pipeline context ───────────────────────────────
  const ctx: PipelineContext = {
    // Input
    userMessage: input.userMessage,
    userName: input.userName,
    userId: input.userId,
    userRole: input.userRole,
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    conversationHistory: input.conversationHistory,
    aiConfig: input.aiConfig,
    sessionId: input.sessionId ?? "",
    onProgress: input.onProgress,
    onPersonaMessage: input.onPersonaMessage,

    // Built during pipeline
    keywords: [],
    knowledgeContext: "",
    knowledgeEntries: [],
    fileContext: "",
    formContext: "",
    onboardingContext: "",
    systemPrompt: "",
    engine: "",
    personas: [],

    // Per-request context (replaces globals)
    currentUser: { id: input.userId, name: input.userName, role: input.userRole },
    lastToolsCalledBySession: _lastToolsCalledBySession,
    commanderAgentId,
    taskId,

    // Output
    text: "",
    files: [],
    toolCalls: [],
    personaMessages: undefined,
    done: false,
  };

  try {
    log.logStart(ctx);
    await botLog({ tenantId: input.tenantId, tenantName: input.tenantName, userId: input.userId, userName: input.userName, type: "user_message", content: input.userMessage });

    // ── Run middleware pipeline ─────────────────────────────
    for (const mw of middlewares) {
      await mw(ctx);
      if (ctx.done) break;
    }

    // ── Complete task + update performance ──────────────────
    if (taskId) {
      try {
        await completeTask(taskId, commanderAgentId, ctx.text.substring(0, 200));
      } catch {}
    }
    await updatePerformance(commanderAgentId, true);

    // ── Audit ──────────────────────────────────────────────
    await recordDecision({
      agentId: commanderAgentId,
      decisionType: "assign",
      taskId: taskId ?? undefined,
      reasoning: `Chat: "${input.userMessage.substring(0, 60)}". Tools: ${ctx.toolCalls.map(t => t.tool).join(", ") || "none"}. Knowledge: ${ctx.knowledgeEntries.length}.`,
    });

    const elapsed = Date.now() - startTime;

    // ── Structured end log ────────────────────────────────
    log.logResponse(ctx.text);
    log.logEnd(elapsed, ctx.toolCalls.length);

    // ── Persistent logs to DB ─────────────────────────────
    const logBase = { tenantId: input.tenantId, tenantName: input.tenantName };
    for (const tc of ctx.toolCalls) {
      await botLog({ ...logBase, type: "tool_call", content: `${tc.tool}(${JSON.stringify(tc.args).substring(0, 200)})`, metadata: { tool: tc.tool, result: JSON.stringify(tc.result).substring(0, 500) } });
    }
    await botLog({ ...logBase, userId: input.userId, userName: input.userName, type: "bot_response", content: ctx.text, metadata: { elapsed, toolCount: ctx.toolCalls.length, engine: ctx.engine } });

    return { text: ctx.text, files: ctx.files, personaMessages: ctx.personaMessages };

  } catch (e: any) {
    // ── Error handling ──────────────────────────────────────
    if (taskId) {
      try { await failTask(taskId, commanderAgentId, e.message); } catch {}
    }
    await updatePerformance(commanderAgentId, false);

    // Save anti-pattern rule (what NOT to do)
    try {
      const intentKeywords = ctx.keywords.slice(0, 3).join(" ");
      await storeKnowledge({
        type: "anti_pattern",
        title: `Anti-pattern: ${intentKeywords}`,
        content: `Khi user hỏi "${intentKeywords}" → TRÁNH: ${e.message.substring(0, 100)}. Cần kiểm tra lại cách gọi tool.`,
        domain: "general",
        tags: ctx.keywords.slice(0, 5),
        sourceAgentId: commanderAgentId,
        outcome: "failure",
      });
    } catch {}

    console.error(`[Pipeline] ✗ Error (${Date.now() - startTime}ms): ${e.message}`);
    return { text: `⚠️ Lỗi: ${e.message}`, files: ctx.files };
  }
}
