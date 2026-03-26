/**
 * Execute Middleware — runs the LLM via AgentRunner or persona conversation.
 */

import { getCommander } from "../../modules/agents/agent-pool.js";
import { AgentRunner, type LLMEngine } from "../../modules/agents/agent-runner.js";
import { routeToPersonas, runPersonaConversation } from "../../modules/agents/persona-conversation.js";
import { executeTool } from "../tool-registry.js";
import { invalidateCache } from "../../modules/cache/resource-cache.js";
import { manageContext } from "../../modules/conversations/token-manager.js";
import { emitEvent } from "../../modules/events/event-bus.js";
import { handleEvent } from "../../modules/events/event-handler.js";
import { logEngine, logToolCall, logLLMDone, logContext, logHistory } from "./logger.js";
import type { PipelineContext } from "./types.js";

const MUTATING_TOOLS = new Set([
  "create_workflow", "create_form", "create_rule",
  "create_collection", "add_row", "update_row", "delete_row",
  "save_tutorial", "save_knowledge",
  "create_agent_template", "spawn_agent", "kill_agent",
  "create_bot", "stop_bot", "set_user_role", "update_ai_config",
]);

export async function executeMiddleware(ctx: PipelineContext): Promise<void> {
  const executeStart = Date.now();
  const commander = getCommander();
  if (!commander) {
    ctx.text = "⚠️ Commander agent chưa khởi tạo. Restart hệ thống.";
    ctx.done = true;
    return;
  }

  // ── Manage context window ──────────────────────────────
  const managed = manageContext({
    systemPrompt: ctx.systemPrompt,
    formContext: ctx.formContext,
    resourceContext: ctx.fileContext,
    knowledgeContext: ctx.knowledgeContext,
    conversationHistory: ctx.conversationHistory,
  });

  const effectivePrompt = managed.systemPrompt;
  const effectiveHistory = managed.history;

  logEngine(ctx.engine as string, ctx.personas.map(p => p.name));
  logContext(ctx);
  logHistory(ctx, effectiveHistory.length, ctx.conversationHistory.length, !!managed.truncated);

  // Dynamic tool progress
  let toolCallCount = 0;
  const toolCtx = {
    sessionId: ctx.sessionId,
    currentUser: ctx.currentUser,
  };

  const runner = new AgentRunner({
    agent: commander.agent,
    engine: ctx.engine as LLMEngine,
    tools: [],
    systemPrompt: effectivePrompt,
    executeTool: async (tool, args) => {
      toolCallCount++;
      const toolStart = Date.now();
      await ctx.onProgress?.(`🔄 [${toolCallCount}] ${tool}...`);

      // Tool execution with retry on failure
      let toolResult: any;
      try {
        toolResult = await executeTool(tool, args, ctx.tenantId, toolCtx);
      } catch (e: any) {
        try {
          toolResult = await executeTool(tool, args, ctx.tenantId, toolCtx);
        } catch (e2: any) {
          toolResult = { error: `Tool ${tool} lỗi: ${e2.message}. KHÔNG bịa kết quả.` };
        }
      }

      // Sanitize large results
      const resultStr = JSON.stringify(toolResult);
      if (resultStr.length > 3000) {
        toolResult = { ...toolResult, _truncated: true, _originalLength: resultStr.length };
      }
      logToolCall(toolCallCount, tool, args, toolResult, Date.now() - toolStart);

      if (MUTATING_TOOLS.has(tool)) {
        invalidateCache(ctx.tenantId);
        const event = {
          type: tool.startsWith("create_") ? "row.created" : tool.startsWith("update_") ? "row.updated" : tool === "delete_row" ? "row.deleted" : "data.changed",
          tenantId: ctx.tenantId,
          collection: (args.collection as string) ?? undefined,
          rowId: (toolResult as any)?.id ?? (args.row_id as string) ?? undefined,
          data: (args.data as Record<string, unknown>) ?? undefined,
          changedFields: args.data ? Object.keys(args.data as object) : undefined,
          triggeredBy: ctx.userName,
          timestamp: Date.now(),
        };
        emitEvent(event).then(() => handleEvent(event)).catch(() => {});
      }
      if (toolResult && typeof toolResult === "object" && (toolResult as any).__send_file__) {
        ctx.files.push({ url: (toolResult as any).url, fileName: (toolResult as any).fileName, mimeType: (toolResult as any).mimeType });
      }
      return toolResult;
    },
    maxToolLoops: 10,
  });

  let result: { text: string; toolCalls: { tool: string }[] };

  if (ctx.personas.length >= 2 && ctx.userMessage.length > 15) {
    console.error(`[Execute] → Multi-persona mode`);
    // Route to personas — skip Commander
    try {
      const { getConfig: gc3 } = await import("../../config.js");
      const cfg3 = gc3();

      const participants = await routeToPersonas({
        userMessage: ctx.userMessage,
        availablePersonas: ctx.personas,
        engine: ctx.engine as LLMEngine,
        workerApiBase: cfg3.WORKER_API_BASE!,
        workerApiKey: cfg3.WORKER_API_KEY!,
        workerModel: cfg3.WORKER_MODEL!,
      });

      console.error(`[Pipeline] Route to: ${participants.join(" → ")}`);

      if (participants.length >= 2) {
        await ctx.onProgress?.("💬 Các agents đang trao đổi...");

        const pMessages = await runPersonaConversation({
          userMessage: ctx.userMessage,
          personas: ctx.personas,
          participantNames: participants,
          conversationHistory: ctx.conversationHistory,
          executeTool: async (tool, args) => {
            await ctx.onProgress?.(`🔄 [${tool}]...`);
            const r = await executeTool(tool, args, ctx.tenantId, toolCtx);
            if (MUTATING_TOOLS.has(tool)) invalidateCache(ctx.tenantId);
            return r;
          },
          engine: ctx.engine as LLMEngine,
          onPersonaMessage: ctx.onPersonaMessage ? async (m) => {
            await ctx.onPersonaMessage!({
              emoji: m.persona.emoji,
              name: m.persona.name,
              content: m.content,
            });
          } : undefined,
        });

        ctx.personaMessages = pMessages.map(m => ({
          emoji: m.persona.emoji,
          name: m.persona.name,
          content: m.content,
        }));

        result = {
          text: pMessages.map(m => `${m.persona.emoji} ${m.persona.name}: ${m.content}`).join("\n\n"),
          toolCalls: [],
        };
      } else {
        // Only 1 participant — fall back to Commander
        result = await runner.think(ctx.userMessage, effectiveHistory);
      }
    } catch (pErr: any) {
      console.error(`[Pipeline] Persona failed, fallback Commander: ${pErr.message}`);
      result = await runner.think(ctx.userMessage, effectiveHistory);
    }
  } else {
    // No personas or short message — Commander handles directly
    console.error(`[Execute] → Commander direct mode`);
    result = await runner.think(ctx.userMessage, effectiveHistory);
  }

  await ctx.onProgress?.("✍️ Đang tổng hợp câu trả lời...");

  ctx.text = result.text;
  ctx.toolCalls = result.toolCalls.map(t => ({ tool: t.tool, args: (t as any).args, result: (t as any).result }));

  logLLMDone(ctx.toolCalls.length, Date.now() - executeStart);
}
