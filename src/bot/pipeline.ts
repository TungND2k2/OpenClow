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
import { AgentRunner, type LLMEngine } from "../modules/agents/agent-runner.js";
import { AGENT_TOOLS } from "../modules/agents/agent-pool.js";
import { executeTool } from "./tool-registry.js";
import { invalidateCache } from "../modules/cache/resource-cache.js";
import { getResourceSummary, buildResourceSummary, formatSummaryForPrompt } from "../modules/cache/resource-cache.js";
import { buildCommanderPrompt } from "./prompt-builder.js";
import { botLog } from "../modules/logs/bot-logger.js";
// knowledge.service removed
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
  formContext?: string;
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
    knowledgeContext: "", fileContext: "", formContext: input.formContext ?? "", systemPrompt: "",
    currentUser: { id: input.userId, name: input.userName, role: input.userRole },
    text: "", files: [], toolCalls: [],
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

    // ── Pre-fetch data (Push model) ───────────────────────
    // Detect relevant collections → fetch rows → inject into context.
    // LLM nhận data sẵn, chỉ cần tools cho WRITE (add/update/delete).
    const { buildDataContext } = await import("../modules/context/data-injector.js");
    const dataContext = await buildDataContext(input.tenantId, input.userMessage, summary);

    // ── Engine routing ────────────────────────────────────
    const GREETING = /^(chào|hi|hello|hey|xin chào|ok|ừ|uh|cảm ơn|thanks|bye|👋)[\s!.?]*$/i;
    const isGreeting = input.userMessage.trim().length < 20 && GREETING.test(input.userMessage.trim());
    const engine: LLMEngine = isGreeting ? "fast-api" : "claude-sdk";

    const systemPrompt = buildCommanderPrompt(input.tenantName, input.userName, input.userRole, input.aiConfig, engine !== "fast-api")
      + (resourceContext ? `\n\nHỆ THỐNG CÓ:\n${resourceContext}` : "")
      + docsContext
      + fileContext
      + dataContext
      + (ctx.formContext ? ctx.formContext : "");

    // Propagate to ctx so logger can read them
    ctx.systemPrompt = systemPrompt;
    ctx.fileContext = fileContext;
    // Knowledge now comes from bot_docs (injected in context step above)

    // Get DB summary for session recovery (inject into system prompt for new conversations)
    let dbSummary = "";
    if (input.conversationHistory.length === 0) {
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

    log.logEngine(engine, []);
    log.logContext(ctx);
    log.logHistory(ctx, input.conversationHistory.length, input.conversationHistory.length, !!dbSummary);

    // ── Step 2: Anthropic API query ───────────────────────
    await input.onProgress?.("🤖 Đang suy nghĩ...");

    const toolCtx = { sessionId: input.sessionId ?? "", currentUser: ctx.currentUser };
    let toolCallCount = 0;

    const runner = new AgentRunner({
      agent: commander.agent,
      engine,
      tools: AGENT_TOOLS,
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
          toolResult = { error: `Tool ${tool} lỗi: ${e.message}` };
        }

        // Truncate large results
        const resultStr = JSON.stringify(toolResult);
        if (resultStr.length > 3000) {
          toolResult = { _truncated: true, _originalLength: resultStr.length, _preview: resultStr.substring(0, 2900) };
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
    await botLog({ ...logBase, userId: input.userId, userName: input.userName, type: "bot_response", content: ctx.text, metadata: { elapsed: Date.now() - startTime, toolCount: ctx.toolCalls.length, engine } });

    return { text: ctx.text, files: _files };

  } catch (e: any) {
    await updatePerformance(commander.agent.id, false);
    log.logError(e.message);
    return { text: `⚠️ Lỗi: ${e.message}`, files: _files };
  }
}
