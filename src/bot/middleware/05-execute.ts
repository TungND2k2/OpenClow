/**
 * Execute Middleware — runs the LLM via AgentRunner or persona conversation.
 */

import { getCommander } from "../../modules/agents/agent-pool.js";
import { AgentRunner, type LLMEngine } from "../../modules/agents/agent-runner.js";
import { routeToPersonas, runPersonaConversation } from "../../modules/agents/persona-conversation.js";
import { executeTool } from "../tool-registry.js";
import type { PipelineContext } from "./types.js";

export async function executeMiddleware(ctx: PipelineContext): Promise<void> {
  const commander = getCommander();
  if (!commander) {
    ctx.text = "⚠️ Commander agent chưa khởi tạo. Restart hệ thống.";
    ctx.done = true;
    return;
  }

  // Dynamic tool progress — no hardcoded labels
  let toolCallCount = 0;
  const toolCtx = {
    sessionId: ctx.sessionId,
    currentUser: ctx.currentUser,
  };

  const runner = new AgentRunner({
    agent: commander.agent,
    engine: ctx.engine as LLMEngine,
    tools: [],
    systemPrompt: ctx.systemPrompt,
    executeTool: async (tool, args) => {
      toolCallCount++;
      const argsPreview = tool === "ssh_exec" ? (args.command as string ?? "") : "";
      await ctx.onProgress?.(`🔄 [${toolCallCount}] ${tool}${argsPreview ? `: ${argsPreview.substring(0, 50)}` : ""}...`);
      const toolResult = await executeTool(tool, args, ctx.tenantId, toolCtx);
      if (toolResult && typeof toolResult === "object" && (toolResult as any).__send_file__) {
        ctx.files.push({ url: (toolResult as any).url, fileName: (toolResult as any).fileName, mimeType: (toolResult as any).mimeType });
      }
      return toolResult;
    },
    maxToolLoops: 10,
  });

  let result: { text: string; toolCalls: { tool: string }[] };

  console.error(`[Execute] Engine: ${ctx.engine}`);
  console.error(`[Execute] Personas: ${ctx.personas.length} (${ctx.personas.map(p => p.name).join(", ")})`);
  console.error(`[Execute] History in prompt: ${ctx.conversationHistory.length} messages`);
  console.error(`[Execute] System prompt: ${ctx.systemPrompt.length} chars`);

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
            return await executeTool(tool, args, ctx.tenantId, toolCtx);
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
        result = await runner.think(ctx.userMessage, ctx.conversationHistory);
      }
    } catch (pErr: any) {
      console.error(`[Pipeline] Persona failed, fallback Commander: ${pErr.message}`);
      result = await runner.think(ctx.userMessage, ctx.conversationHistory);
    }
  } else {
    // No personas or short message — Commander handles directly
    console.error(`[Execute] → Commander direct mode`);
    result = await runner.think(ctx.userMessage, ctx.conversationHistory);
  }

  await ctx.onProgress?.("✍️ Đang tổng hợp câu trả lời...");

  ctx.text = result.text;
  ctx.toolCalls = result.toolCalls.map(t => ({ tool: t.tool, args: (t as any).args, result: (t as any).result }));

  console.error(`[Execute] Response: ${ctx.text.length} chars, ${ctx.toolCalls.length} tools: [${ctx.toolCalls.map(t => t.tool).join(", ")}]`);
}
