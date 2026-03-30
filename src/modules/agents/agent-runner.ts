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
import Anthropic from "@anthropic-ai/sdk";

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
        return await this.callAnthropicMessages(userMessage, conversationHistory);
      } catch (err: any) {
        console.error(`[Agent:${this.agent.name}] Anthropic API failed: ${err.message.substring(0, 100)} → fallback fast-api`);
        return this.callFastAPIWithTools(userMessage, conversationHistory);
      }
    }
    return this.callFastAPIWithTools(userMessage, conversationHistory);
  }

  /**
   * Anthropic Messages API — native tool calling via tool_use/tool_result blocks.
   */
  private async callAnthropicMessages(
    userMessage: string,
    history: { role: string; content: string }[],
  ): Promise<ThinkResult> {
    const { getConfig } = await import("../../config.js");
    const cfg = getConfig();
    const prefix = `[Agent:${this.agent.name}]`;

    // Auth priority: COMMANDER_API_KEY > CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_API_KEY (env)
    let client: Anthropic;
    if (cfg.COMMANDER_API_KEY) {
      client = new Anthropic({ apiKey: cfg.COMMANDER_API_KEY });
    } else if (cfg.CLAUDE_CODE_OAUTH_TOKEN) {
      client = new Anthropic({ authToken: cfg.CLAUDE_CODE_OAUTH_TOKEN });
    } else {
      // Fallback: SDK auto-reads ANTHROPIC_API_KEY from env
      client = new Anthropic();
    }

    // Map tool definitions to Anthropic format
    const anthropicTools: Anthropic.Tool[] = this.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));

    // Build message array from conversation history
    const messages: Anthropic.MessageParam[] = [
      ...history.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user", content: userMessage },
    ];

    // Inject dbSummary into system prompt for context recovery
    const systemStr = this.dbSummary
      ? `${this.systemPrompt}\n\n[Context phiên trước]: ${this.dbSummary}`
      : this.systemPrompt;

    const allToolResults: ToolResult[] = [];
    console.error(`${prefix} Anthropic API calling (${this.tools.length} tools)...`);

    for (let loop = 0; loop <= this.maxToolLoops; loop++) {
      const response = await client.messages.create({
        model: cfg.COMMANDER_MODEL,
        max_tokens: 4096,
        system: systemStr,
        messages,
        ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      });

      // Add assistant turn to message history for next iteration
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map(b => b.text)
          .join("");
        console.error(`${prefix} done: ${allToolResults.length} tools called`);
        return { text, toolCalls: allToolResults };
      }

      // Execute all tool_use blocks
      const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const toolResultContent: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        const args = block.input as Record<string, unknown>;
        let result: unknown;
        try {
          result = await this.executeTool(block.name, args);
          allToolResults.push({ tool: block.name, args, result });
        } catch (err: any) {
          result = { error: err.message };
          allToolResults.push({ tool: block.name, args, result });
        }
        toolResultContent.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result).substring(0, 3000),
        });
      }

      messages.push({ role: "user", content: toolResultContent });
    }

    console.error(`${prefix} reached tool loop limit`);
    return { text: "Đã đạt giới hạn xử lý.", toolCalls: allToolResults };
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
