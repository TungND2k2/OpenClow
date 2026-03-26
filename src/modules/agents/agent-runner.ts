/**
 * AgentRunner — Claude Agent SDK with persistent sessions.
 *
 * SDK sessions = context in memory (fast, no DB query per message)
 * PostgreSQL = backup (summary, logs, data)
 *
 * Flow:
 *   1. Resume SDK session (if exists) or create new (inject summary from DB)
 *   2. SDK query (native tools, native context management)
 *   3. Save summary to DB periodically (for backup on restart)
 */

import type { InferSelectModel } from "drizzle-orm";
import type { agents } from "../../db/schemas/agents.js";

export type AgentRecord = InferSelectModel<typeof agents>;
export type LLMEngine = "fast-api" | "claude-sdk" | "claude-cli";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface ThinkResult {
  text: string;
  toolCalls: ToolResult[];
  sdkSessionId?: string;
}

// ── SDK Session Map — per user per tenant ──────────────
const sessionMap = new Map<string, string>(); // key: tenantId:userId → SDK sessionId

export function getSessionKey(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

export function getSDKSessionId(tenantId: string, userId: string): string | undefined {
  return sessionMap.get(getSessionKey(tenantId, userId));
}

export function setSDKSessionId(tenantId: string, userId: string, sessionId: string): void {
  sessionMap.set(getSessionKey(tenantId, userId), sessionId);
}

// ── AgentRunner ────────────────────────────────────────

export interface AgentRunnerConfig {
  agent: AgentRecord;
  engine: LLMEngine;
  tools: ToolDefinition[];
  systemPrompt: string;
  executeTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  maxToolLoops?: number;
  tenantId?: string;
  userId?: string;
  dbSummary?: string; // inject from PostgreSQL when SDK session lost
}

export class AgentRunner {
  readonly agent: AgentRecord;
  readonly engine: LLMEngine;
  private systemPrompt: string;
  private executeTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  private maxToolLoops: number;
  private tenantId: string;
  private userId: string;
  private dbSummary: string;

  constructor(config: AgentRunnerConfig) {
    this.agent = config.agent;
    this.engine = config.engine;
    this.systemPrompt = config.systemPrompt;
    this.executeTool = config.executeTool;
    this.maxToolLoops = config.maxToolLoops ?? 10;
    this.tenantId = config.tenantId ?? "";
    this.userId = config.userId ?? "";
    this.dbSummary = config.dbSummary ?? "";
  }

  async think(
    userMessage: string,
    conversationHistory: { role: string; content: string }[] = [],
  ): Promise<ThinkResult> {
    if (this.engine === "claude-sdk" || this.engine === "claude-cli") {
      try {
        return await this.callSDK(userMessage, conversationHistory);
      } catch (err: any) {
        console.error(`[Agent:${this.agent.name}] SDK failed: ${err.message.substring(0, 100)} → fallback fast-api`);
        return this.callFastAPIWithTools(userMessage, conversationHistory);
      }
    }
    return this.callFastAPIWithTools(userMessage, conversationHistory);
  }

  /**
   * Claude Agent SDK with sessions.
   */
  private async callSDK(
    userMessage: string,
    history: { role: string; content: string }[],
  ): Promise<ThinkResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const prefix = `[Agent:${this.agent.name}]`;
    const allToolResults: ToolResult[] = [];
    let finalText = "";

    // Check for existing SDK session
    const existingSessionId = getSDKSessionId(this.tenantId, this.userId);
    const isResume = !!existingSessionId;

    // Build prompt
    let prompt = userMessage;
    if (!isResume && this.dbSummary) {
      // New session — inject DB summary as context
      prompt = `[Context từ phiên trước]: ${this.dbSummary}\n\n---\n\nUser: ${userMessage}`;
      console.error(`${prefix} SDK new session (injected DB summary: ${this.dbSummary.length} chars)`);
    } else if (isResume) {
      console.error(`${prefix} SDK resume session ${existingSessionId!.substring(0, 8)}`);
    } else {
      console.error(`${prefix} SDK new session (no prior context)`);
    }

    console.error(`${prefix} SDK calling...`);
    let newSessionId: string | undefined;

    for await (const msg of query({
      prompt,
      options: {
        systemPrompt: this.systemPrompt,
        allowedTools: [],
        maxTurns: this.maxToolLoops,
        ...(isResume ? { resume: existingSessionId } : {}),
      },
    })) {
      // Capture session ID
      if (msg.type === "system" && (msg as any).subtype === "init") {
        newSessionId = (msg as any).session_id;
      }

      // Text response
      if (msg.type === "assistant" && (msg as any).message) {
        for (const block of (msg as any).message.content ?? []) {
          if (typeof block === "string") finalText += block;
          else if (block.type === "text") finalText += block.text;
        }
      }

      // Result
      if (msg.type === "result" && "result" in msg) {
        finalText = (msg as any).result ?? finalText;
      }
    }

    // Save session ID for next message
    if (newSessionId) {
      setSDKSessionId(this.tenantId, this.userId, newSessionId);
    }

    // Parse tool_calls from text (SDK may output them in text)
    const toolCalls = this.parseToolCalls(finalText);
    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        try {
          const result = await this.executeTool(tc.tool, tc.args);
          allToolResults.push({ tool: tc.tool, args: tc.args, result });
        } catch (err: any) {
          allToolResults.push({ tool: tc.tool, args: tc.args, result: { error: err.message } });
        }
      }

      // Follow-up call with tool results
      const toolResultText = allToolResults
        .map(r => `[Tool: ${r.tool}] Result:\n${JSON.stringify(r.result, null, 2).substring(0, 1000)}`)
        .join("\n\n");

      let followUp = "";
      for await (const msg of query({
        prompt: toolResultText + "\n\nDựa trên kết quả tools, trả lời user.",
        options: {
          systemPrompt: this.systemPrompt,
          allowedTools: [],
          maxTurns: 1,
          ...(newSessionId ? { resume: newSessionId } : {}),
        },
      })) {
        if (msg.type === "result" && "result" in msg) followUp = (msg as any).result ?? "";
      }

      console.error(`${prefix} SDK done: ${allToolResults.length} tools`);
      return {
        text: followUp || finalText.replace(/```tool_calls[\s\S]*?```/g, "").trim(),
        toolCalls: allToolResults,
        sdkSessionId: newSessionId,
      };
    }

    console.error(`${prefix} SDK done: 0 tools`);
    return { text: finalText.trim(), toolCalls: [], sdkSessionId: newSessionId };
  }

  /**
   * Fast API — fallback.
   */
  private async callFastAPIWithTools(
    userMessage: string,
    history: { role: string; content: string }[],
  ): Promise<ThinkResult> {
    const allToolResults: ToolResult[] = [];
    let currentHistory = [...history];
    let currentMessage = userMessage;

    for (let loop = 0; loop < this.maxToolLoops; loop++) {
      const response = await callFastAPI(currentMessage, this.systemPrompt, currentHistory);
      const toolCalls = this.parseToolCalls(response);

      if (toolCalls.length === 0) {
        return { text: response.replace(/```tool_calls[\s\S]*?```/g, "").trim(), toolCalls: allToolResults };
      }

      for (const tc of toolCalls) {
        try {
          const result = await this.executeTool(tc.tool, tc.args);
          allToolResults.push({ tool: tc.tool, args: tc.args, result });
        } catch (err: any) {
          allToolResults.push({ tool: tc.tool, args: tc.args, result: { error: err.message } });
        }
      }

      const toolResultText = allToolResults.slice(-toolCalls.length)
        .map(r => `[Tool: ${r.tool}] Result:\n${JSON.stringify(r.result, null, 2).substring(0, 1000)}`)
        .join("\n\n");

      currentHistory = [
        ...currentHistory,
        { role: "user", content: currentMessage },
        { role: "assistant", content: response },
      ];
      currentMessage = toolResultText;
    }

    return { text: "Đã đạt giới hạn xử lý.", toolCalls: allToolResults };
  }

  private parseToolCalls(text: string): { tool: string; args: Record<string, unknown> }[] {
    const patterns = [/```tool_calls\s*\n?([\s\S]*?)```/, /```json\s*\n?(\[[\s\S]*?\])\s*```/];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      try {
        const parsed = JSON.parse(match[1].trim());
        return (Array.isArray(parsed) ? parsed : [parsed]).filter((t: any) => t.tool).map((t: any) => ({ tool: t.tool, args: t.args ?? {} }));
      } catch { continue; }
    }
    return [];
  }
}

/**
 * Standalone fast-api call.
 */
export async function callFastAPI(
  userMessage: string,
  systemPrompt: string,
  history: { role: string; content: string }[],
): Promise<string> {
  const { getConfig } = await import("../../config.js");
  const config = getConfig();
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];
  const resp = await fetch(`${config.WORKER_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.WORKER_API_KEY}` },
    body: JSON.stringify({ model: config.WORKER_MODEL, messages, max_tokens: 2048, temperature: 0.3 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`Fast API ${resp.status}`);
  const data = (await resp.json()) as any;
  return data.choices?.[0]?.message?.content ?? "";
}
