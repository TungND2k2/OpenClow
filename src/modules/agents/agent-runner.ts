/**
 * AgentRunner — Anthropic Messages API with native tool calling.
 *
 * Engines:
 *   claude-sdk / claude-cli → Anthropic Messages API, tools: parameter, tool_use loop
 *   fast-api               → OpenAI-compatible API, text-parsed tool_calls blocks
 *
 * Context is managed by the caller (pipeline.ts) via conversationHistory.
 * dbSummary injected into system prompt for context recovery on first call.
 */

import type { InferSelectModel } from "drizzle-orm";
import type { agents } from "../../db/schemas/agents.js";
// Claude Agent SDK used via dynamic import in callSDK()

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
  private tools: ToolDefinition[];
  private executeTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  private maxToolLoops: number;
  private tenantId: string;
  private userId: string;
  private dbSummary: string;

  constructor(config: AgentRunnerConfig) {
    this.agent = config.agent;
    this.engine = config.engine;
    this.systemPrompt = config.systemPrompt;
    this.tools = config.tools ?? [];
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
        console.error(`[Agent:${this.agent.name}] Anthropic API failed: ${err.message.substring(0, 100)} → fallback fast-api`);
        return this.callFastAPIWithTools(userMessage, conversationHistory);
      }
    }
    return this.callFastAPIWithTools(userMessage, conversationHistory);
  }

  /**
   * Claude Agent SDK + MCP — native tool calling via Max subscription.
   * SDK spawns MCP subprocess → discovers tools → calls native → no text parsing.
   */
  private async callSDK(
    userMessage: string,
    history: { role: string; content: string }[],
  ): Promise<ThinkResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { resolve } = await import("path");
    const prefix = `[Agent:${this.agent.name}]`;
    const allToolResults: ToolResult[] = [];

    // Build prompt with history
    let prompt = userMessage;
    if (history.length > 0) {
      const historyText = history.map(h => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`).join("\n\n");
      prompt = `${historyText}\n\nUser: ${userMessage}`;
    }
    if (this.dbSummary) {
      prompt = `[Context phiên trước]: ${this.dbSummary}\n\n---\n\n${prompt}`;
    }

    console.error(`${prefix} SDK + MCP calling...`);
    let finalText = "";

    // MCP server path — same codebase
    const mcpServerPath = resolve(process.cwd(), "src/mcp/stdio-server.ts");

    for await (const msg of query({
      prompt,
      options: {
        systemPrompt: this.systemPrompt,
        maxTurns: this.maxToolLoops,
        mcpServers: {
          openclaw: {
            command: "npx",
            args: ["tsx", mcpServerPath],
            env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
          },
        },
      },
    })) {
      // Track tool calls from SDK messages
      if (msg.type === "assistant" && (msg as any).message) {
        for (const block of (msg as any).message.content ?? []) {
          if (typeof block === "string") finalText += block;
          else if (block.type === "text") finalText += block.text;
          else if (block.type === "tool_use") {
            // SDK called a tool natively via MCP
            allToolResults.push({
              tool: block.name,
              args: block.input as Record<string, unknown>,
              result: "executed via MCP",
            });
          }
        }
      }
      if (msg.type === "result" && "result" in msg) {
        finalText = (msg as any).result ?? finalText;
      }
    }

    console.error(`${prefix} SDK + MCP done: ${allToolResults.length} tools`);
    return { text: finalText.trim(), toolCalls: allToolResults };
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
