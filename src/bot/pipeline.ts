/**
 * Pipeline — simplified with SDK sessions.
 *
 * 3 steps:
 *   1. Resume/Create SDK session (inject DB summary if session lost)
 *   2. SDK query (native tools, context, agent loop)
 *   3. Save logs + summary to DB (persistent backup)
 */

import { getCommander } from "../modules/agents/agent-pool.js";
import { heartbeat, updatePerformance } from "../modules/agents/agent.service.js";
import { AgentRunner, type LLMEngine, getSDKSessionId } from "../modules/agents/agent-runner.js";
import { executeTool } from "./tool-registry.js";
import { invalidateCache } from "../modules/cache/resource-cache.js";
import { getResourceSummary, buildResourceSummary, formatSummaryForPrompt } from "../modules/cache/resource-cache.js";
import { buildCommanderPrompt } from "./prompt-builder.js";
import { botLog } from "../modules/logs/bot-logger.js";
import * as log from "./middleware/logger.js";
import type { PipelineContext } from "./middleware/types.js";

export interface PersonaMsg { emoji: string; name: string; content: string }
export interface CommanderResponse {
  text: string;
  files: { url: string; fileName: string; mimeType: string }[];
  personaMessages?: PersonaMsg[];
}

const MUTATING_TOOLS = new Set([
  "add_row", "update_row", "delete_row", "create_collection",
  "create_form", "create_workflow", "create_rule", "set_user_role",
  "save_knowledge", "update_instructions", "create_bot", "stop_bot",
  "create_agent_template", "spawn_agent", "kill_agent", "create_cron",
  "ssh_exec", "start_form", "update_form_field",
]);

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
  const _files: CommanderResponse["files"] = [];

  // ── Get Commander ────────────────────────────────────
  const commander = getCommander();
  if (!commander) return { text: "⚠️ Commander chưa khởi tạo.", files: [] };
  await heartbeat(commander.agent.id);

  // ── Structured log ───────────────────────────────────
  const ctx: PipelineContext = {
    userMessage: input.userMessage, userName: input.userName, userId: input.userId,
    userRole: input.userRole, tenantId: input.tenantId, tenantName: input.tenantName,
    conversationHistory: input.conversationHistory, aiConfig: input.aiConfig,
    sessionId: input.sessionId ?? "", onProgress: input.onProgress,
    onPersonaMessage: input.onPersonaMessage,
    keywords: [], knowledgeContext: "", knowledgeEntries: [], fileContext: "",
    formContext: "", onboardingContext: "", systemPrompt: "", engine: "",
    personas: [], currentUser: { id: input.userId, name: input.userName, role: input.userRole },
    lastToolsCalledBySession: new Map(), commanderAgentId: commander.agent.id,
    taskId: null, text: "", files: [], toolCalls: [], done: false,
  };

  log.logStart(ctx);
  await botLog({ tenantId: input.tenantId, tenantName: input.tenantName, userId: input.userId, userName: input.userName, type: "user_message", content: input.userMessage });

  try {
    // ── Step 1: Build context ────────────────────────────
    let summary = getResourceSummary(input.tenantId);
    if (!summary) summary = await buildResourceSummary(input.tenantId);
    const resourceContext = formatSummaryForPrompt(summary);

    // Inject user's latest file context
    const { buildFileContextForUser } = await import("../modules/context/user-file-context.js");
    const fileContext = buildFileContextForUser(input.tenantId, input.userId);

    // Load bot doc (1 per tenant — inject thẳng vào prompt)
    let docsContext = "";
    try {
      const { getDb } = await import("../db/connection.js");
      const { sql } = await import("drizzle-orm");
      const db = getDb();
      const docs = await db.execute(sql`SELECT content FROM bot_docs WHERE tenant_id = ${input.tenantId} LIMIT 1`);
      const content = (docs as any[])[0]?.content;
      if (content) {
        docsContext = `\n\nKIẾN THỨC ĐÃ HỌC:\n${content}`;
      }
    } catch {}

    const systemPrompt = buildCommanderPrompt(input.tenantName, input.userName, input.userRole, input.aiConfig)
      + (resourceContext ? `\n\nHỆ THỐNG CÓ:\n${resourceContext}` : "")
      + docsContext
      + fileContext;

    // Get DB summary for session recovery
    let dbSummary = "";
    const existingSDKSession = getSDKSessionId(input.tenantId, input.userId);
    if (!existingSDKSession) {
      // No SDK session — load summary from DB conversation
      try {
        const { getDb } = await import("../db/connection.js");
        const { conversationSessions } = await import("../db/schema.js");
        const { eq, and } = await import("drizzle-orm");
        const db = getDb();
        const session = (await db.select().from(conversationSessions).where(
          and(eq(conversationSessions.tenantId, input.tenantId), eq(conversationSessions.channelUserId, input.userId))
        ).limit(1))[0];
        const state = typeof session?.state === "string" ? JSON.parse(session.state) : session?.state;
        dbSummary = state?.summary ?? "";
      } catch {}
    }

    // ── Engine routing ────────────────────────────────────
    const GREETING = /^(chào|hi|hello|hey|xin chào|ok|ừ|uh|cảm ơn|thanks|bye|👋)[\s!.?]*$/i;
    const isGreeting = input.userMessage.trim().length < 20 && GREETING.test(input.userMessage.trim());
    const engine: LLMEngine = isGreeting ? "fast-api" : "claude-sdk";

    log.logEngine(engine, []);
    log.logContext(ctx);
    log.logHistory(ctx, input.conversationHistory.length, input.conversationHistory.length, !!dbSummary);

    // ── Step 2: SDK query ─────────────────────────────────
    await input.onProgress?.("🤖 Đang suy nghĩ...");

    const toolCtx = { sessionId: input.sessionId ?? "", currentUser: ctx.currentUser };
    let toolCallCount = 0;

    const runner = new AgentRunner({
      agent: commander.agent,
      engine,
      tools: [],
      systemPrompt,
      tenantId: input.tenantId,
      userId: input.userId,
      dbSummary,
      executeTool: async (tool, args) => {
        toolCallCount++;
        const toolStart = Date.now();
        await input.onProgress?.(`🔄 [${toolCallCount}] ${tool}...`);

        let toolResult: any;
        try {
          toolResult = await executeTool(tool, args, input.tenantId, toolCtx);
        } catch (e: any) {
          try { toolResult = await executeTool(tool, args, input.tenantId, toolCtx); }
          catch (e2: any) { toolResult = { error: `Tool ${tool} lỗi: ${e2.message}` }; }
        }

        // Truncate large results
        if (JSON.stringify(toolResult).length > 3000) {
          toolResult = { ...toolResult, _truncated: true };
        }

        log.logToolCall(toolCallCount, tool, args, toolResult, Date.now() - toolStart);
        ctx.toolCalls.push({ tool, args, result: toolResult });

        if (MUTATING_TOOLS.has(tool)) invalidateCache(input.tenantId);
        return toolResult;
      },
    });

    const result = await runner.think(input.userMessage, input.conversationHistory);
    ctx.text = result.text;

    // ── Step 3: Log + persist ─────────────────────────────
    await updatePerformance(commander.agent.id, true);
    log.logResponse(ctx.text);
    log.logEnd(Date.now() - startTime, ctx.toolCalls.length);

    // Persistent logs
    const logBase = { tenantId: input.tenantId, tenantName: input.tenantName };
    for (const tc of ctx.toolCalls) {
      await botLog({ ...logBase, type: "tool_call", content: `${tc.tool}(${JSON.stringify(tc.args).substring(0, 200)})`, metadata: { tool: tc.tool } });
    }
    await botLog({ ...logBase, userId: input.userId, userName: input.userName, type: "bot_response", content: ctx.text, metadata: { elapsed: Date.now() - startTime, toolCount: ctx.toolCalls.length, engine, sdkSessionId: result.sdkSessionId } });

    return { text: ctx.text, files: _files };

  } catch (e: any) {
    await updatePerformance(commander.agent.id, false);
    log.logError(e.message);
    return { text: `⚠️ Lỗi: ${e.message}`, files: _files };
  }
}
