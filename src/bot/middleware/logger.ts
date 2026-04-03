/**
 * Pipeline Logger — structured, readable logs for debugging.
 * One glance = understand full pipeline flow.
 */

import { estimateTokens } from "../../modules/context/token-counter.js";
import type { PipelineContext } from "./types.js";

const SEP = "═══════════════════════════════════════════";
const L = (msg: string) => console.error(msg);

export function logStart(ctx: PipelineContext) {
  L(SEP);
  L(`[${ctx.tenantName}] ${ctx.userName} (${ctx.userRole}) → "${ctx.userMessage.substring(0, 80)}"`);
  L(SEP);
}

export function logContext(ctx: PipelineContext) {
  const promptTokens = estimateTokens(ctx.systemPrompt);
  const cfg = ctx.aiConfig as any;
  L(`[Context] System prompt: ~${promptTokens} tokens`);
  L(`  ├── Bot: ${cfg.bot_name ?? "?"} (${cfg.bot_intro ?? "?"})`);
  L(`  ├── File ctx: ${ctx.fileContext ? "injected" : "none"}`);
  L(`  ├── Form state: ${ctx.formContext ? "ACTIVE" : "none"}`);
  if (ctx.formContext) L(`  │   ${ctx.formContext.substring(0, 100).replace(/\n/g, " ")}`);
}

export function logHistory(ctx: PipelineContext, kept: number, total: number, summary: boolean) {
  L(`[History] ${total} messages → kept ${kept}${summary ? " + summary" : ""}`);
}

export function logKnowledge(entries: { score: number; title: string; type: string }[]) {
  if (entries.length === 0) {
    L(`[Knowledge] No matches`);
    return;
  }
  L(`[Knowledge] ${entries.length} matches:`);
  for (const e of entries.slice(0, 3)) {
    L(`  ├── ${e.score.toFixed(2)} [${e.type}] "${e.title.substring(0, 50)}"`);
  }
}

export function logEngine(engine: string, personas: string[]) {
  L(`[Engine] ${engine}${personas.length > 0 ? ` → personas: ${personas.join(", ")}` : ""}`);
}

export function logToolCall(index: number, tool: string, args: any, result: any, durationMs: number) {
  const argsStr = JSON.stringify(args).substring(0, 80);
  const resultStr = typeof result === "object" && result?.error
    ? `ERROR: ${result.error}`
    : `OK`;
  L(`  ├── Tool ${index}: ${tool}(${argsStr}) → ${resultStr} (${durationMs}ms)`);
}

export function logLLMDone(toolCount: number, durationMs: number) {
  L(`[LLM] Done: ${toolCount} tools, ${durationMs}ms`);
}

export function logResponse(text: string) {
  const preview = text.substring(0, 120).replace(/\n/g, " ");
  L(`[Response] ${text.length} chars: "${preview}${text.length > 120 ? "..." : ""}"`);
}

export function logEnd(durationMs: number, toolCount: number) {
  L(`[Pipeline] Total: ${durationMs}ms, ${toolCount} tools`);
  L(SEP);
}

export function logError(error: string) {
  L(`[ERROR] ${error}`);
  L(SEP);
}

export function logCompact(summarized: number, kept: number) {
  L(`[Compact] ${summarized} messages → summary, kept ${kept}`);
}

export function logFeedback(signal: string) {
  if (signal !== "neutral") {
    L(`[Feedback] ${signal}`);
  }
}
