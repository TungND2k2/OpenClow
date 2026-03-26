/**
 * AgentRunner — wrapper around LLM "brain" for each agent.
 *
 * Engines:
 *   - claude-sdk  → Claude Agent SDK (native tools, Max subscription)
 *   - fast-api    → OpenAI-compatible API (x-or.cloud, cheap + fast)
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
}

export interface AgentRunnerConfig {
  agent: AgentRecord;
  engine: LLMEngine;
  tools: { name: string; description: string; parameters: Record<string, unknown> }[];
  systemPrompt: string;
  executeTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  maxToolLoops?: number;
}

export class AgentRunner {
  readonly agent: AgentRecord;
  readonly engine: LLMEngine;
  private systemPrompt: string;
  private executeTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  private maxToolLoops: number;

  constructor(config: AgentRunnerConfig) {
    this.agent = config.agent;
    this.engine = config.engine;
    this.systemPrompt = config.systemPrompt;
    this.executeTool = config.executeTool;
    this.maxToolLoops = config.maxToolLoops ?? 10;
  }

  async think(
    userMessage: string,
    conversationHistory: { role: string; content: string }[] = [],
  ): Promise<ThinkResult> {
    const prefix = `[Agent:${this.agent.name}]`;

    if (this.engine === "claude-sdk" || this.engine === "claude-cli") {
      try {
        return await this.callSDK(userMessage, conversationHistory);
      } catch (err: any) {
        console.error(`${prefix} SDK failed: ${err.message.substring(0, 100)} → fallback fast-api`);
        return this.callFastAPIWithTools(userMessage, conversationHistory);
      }
    }
    return this.callFastAPIWithTools(userMessage, conversationHistory);
  }

  /**
   * Claude Agent SDK — native tool execution via Max subscription.
   */
  private async callSDK(
    userMessage: string,
    history: { role: string; content: string }[],
  ): Promise<ThinkResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const prefix = `[Agent:${this.agent.name}]`;

    const prompt = this.buildPromptWithHistory(userMessage, history);
    const allToolResults: ToolResult[] = [];
    let finalText = "";

    console.error(`${prefix} SDK calling...`);

    for await (const msg of query({
      prompt,
      options: {
        systemPrompt: this.systemPrompt,
        allowedTools: [],
        maxTurns: this.maxToolLoops,
      },
    })) {
      // Handle different message types
      if (msg.type === "assistant" && msg.message) {
        // Text response
        for (const block of msg.message.content ?? []) {
          if (typeof block === "string") {
            finalText += block;
          } else if (block.type === "text") {
            finalText += block.text;
          }
        }
      }

      if (msg.type === "result" && "result" in msg) {
        finalText = (msg as any).result ?? finalText;
      }
    }

    // Parse tool_calls from text (SDK may still output them as text)
    const toolCalls = this.parseToolCalls(finalText);
    if (toolCalls.length > 0) {
      // Execute tools manually
      for (const tc of toolCalls) {
        try {
          const result = await this.executeTool(tc.tool, tc.args);
          allToolResults.push({ tool: tc.tool, args: tc.args, result });
        } catch (err: any) {
          allToolResults.push({ tool: tc.tool, args: tc.args, result: { error: err.message } });
        }
      }

      // Call SDK again with tool results for final response
      const toolResultText = allToolResults
        .map(r => `[Tool: ${r.tool}] Result:\n${JSON.stringify(r.result, null, 2).substring(0, 1000)}`)
        .join("\n\n");

      let followUp = "";
      for await (const msg of query({
        prompt: toolResultText + "\n\nDựa trên kết quả tools, trả lời user ngắn gọn.",
        options: {
          systemPrompt: this.systemPrompt,
          allowedTools: [],
          maxTurns: 1,
        },
      })) {
        if (msg.type === "result" && "result" in msg) followUp = (msg as any).result ?? "";
      }

      console.error(`${prefix} SDK done: ${allToolResults.length} tools`);
      return { text: followUp || finalText.replace(/```tool_calls[\s\S]*?```/g, "").trim(), toolCalls: allToolResults };
    }

    console.error(`${prefix} SDK done: 0 tools`);
    return { text: finalText.trim(), toolCalls: [] };
  }

  /**
   * Fast API with tool parsing — fallback.
   */
  private async callFastAPIWithTools(
    userMessage: string,
    history: { role: string; content: string }[],
  ): Promise<ThinkResult> {
    const allToolResults: ToolResult[] = [];
    let currentHistory = [...history];
    let currentMessage = userMessage;

    for (let loop = 0; loop < this.maxToolLoops; loop++) {
      const response = await this.callFastAPI(currentMessage, currentHistory);
      const toolCalls = this.parseToolCalls(response);

      if (toolCalls.length === 0) {
        const cleanText = response.replace(/```tool_calls[\s\S]*?```/g, "").trim();
        return { text: cleanText, toolCalls: allToolResults };
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

  private async callFastAPI(
    userMessage: string,
    history: { role: string; content: string }[],
  ): Promise<string> {
    const { getConfig } = await import("../../config.js");
    const config = getConfig();

    const messages = [
      { role: "system", content: this.systemPrompt },
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: "user", content: userMessage },
    ];

    const resp = await fetch(`${config.WORKER_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.WORKER_API_KEY}`,
      },
      body: JSON.stringify({
        model: config.WORKER_MODEL,
        messages,
        max_tokens: 2048,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = (await resp.json()) as any;
    return data.choices?.[0]?.message?.content ?? "";
  }

  private buildPromptWithHistory(
    userMessage: string,
    history: { role: string; content: string }[],
  ): string {
    if (history.length === 0) return userMessage;
    const historyText = history
      .map(h => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
      .join("\n\n");
    return `${historyText}\n\nUser: ${userMessage}`;
  }

  private parseToolCalls(text: string): { tool: string; args: Record<string, unknown> }[] {
    const patterns = [
      /```tool_calls\s*\n?([\s\S]*?)```/,
      /```json\s*\n?(\[[\s\S]*?\])\s*```/,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      try {
        const parsed = JSON.parse(match[1].trim());
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        return arr.filter((t: any) => t.tool).map((t: any) => ({
          tool: t.tool,
          args: t.args ?? {},
        }));
      } catch { continue; }
    }
    return [];
  }
}

/**
 * Standalone fast-api call — used by compactor + feedback detection.
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
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.WORKER_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.WORKER_MODEL,
      messages,
      max_tokens: 1024,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) throw new Error(`Fast API ${resp.status}`);
  const data = (await resp.json()) as any;
  return data.choices?.[0]?.message?.content ?? "";
}
