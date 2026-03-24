/**
 * Route Middleware — Smart Router.
 *
 * 1. Greeting → fast-api (instant)
 * 2. Knowledge says tools needed → claude-cli
 * 3. Default → claude-cli (accuracy first)
 * 4. Load personas for multi-agent routing
 */

import { getPersonas } from "../../modules/agents/persona-conversation.js";
import type { PipelineContext } from "./types.js";

const GREETING = /^(chào|hi|hello|hey|xin chào|ok|ừ|uh|cảm ơn|thanks|good|tốt|bye|tạm biệt|👋|🤝)[\s!.?]*$/i;

export async function routeMiddleware(ctx: PipelineContext): Promise<void> {
  await ctx.onProgress?.("🤖 Đang xử lý...");
  const msg = ctx.userMessage.trim();

  // ── Quick greeting ────────────────────────────────────
  if (msg.length < 20 && GREETING.test(msg)) {
    ctx.engine = "fast-api";
    ctx.personas = [];
    console.error(`[Route] Engine: fast-api (greeting)`);
    return;
  }

  // ── Check if knowledge rules suggest tools ────────────
  const hasToolRules = ctx.knowledgeEntries.some(k =>
    k.content?.includes("→ gọi tools:") && (k as any).usageCount > 0
  );

  // ── Load personas ─────────────────────────────────────
  ctx.personas = await getPersonas(ctx.tenantId);

  // ── Engine decision ───────────────────────────────────
  // Default CLI for accuracy. Only fast-api for greetings (above).
  ctx.engine = "claude-cli";
  console.error(`[Route] Engine: claude-cli${hasToolRules ? " (knowledge: tools needed)" : " (default)"}`);
  console.error(`[Route] Personas: ${ctx.personas.length} (${ctx.personas.map((p: any) => p.name).join(", ")})`);
}
