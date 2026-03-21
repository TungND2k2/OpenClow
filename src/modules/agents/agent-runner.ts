/**
 * AgentRunner — wrapper around an LLM "brain" for each agent record.
 *
 * An agent is a DB entity (role, capabilities, performance).
 * An AgentRunner gives it a brain (LLM) so it can think, decide, call tools.
 *
 * LLMs are RESOURCES, not agents:
 *   - Claude Max (SDK)    → Commander brain (complex reasoning)
 *   - x-or.cloud (mini)   → Worker brain (fast execution)
 */

import type { InferSelectModel } from "drizzle-orm";
import type { agents } from "../../db/schemas/agents.js";

export type AgentRecord = InferSelectModel<typeof agents>;

export type LLMEngine = "fast-api" | "claude-cli";

// ── Semaphore — limit concurrent Claude CLI processes ────────

const MAX_CONCURRENT_CLI = 5; // 5.8GB RAM, each CLI ~150MB, 5x = ~750MB
let _cliRunning = 0;
const _cliQueue: (() => void)[] = [];

function acquireCLI(): Promise<void> {
  if (_cliRunning < MAX_CONCURRENT_CLI) {
    _cliRunning++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _cliQueue.push(() => { _cliRunning++; resolve(); }));
}

function releaseCLI(): void {
  _cliRunning--;
  const next = _cliQueue.shift();
  if (next) next();
}

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
  tools: ToolDefinition[];
  systemPrompt: string;
  executeTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  maxToolLoops?: number;
}

/**
 * AgentRunner — gives an agent record a "brain" to think with.
 *
 * Usage:
 *   const runner = new AgentRunner({ agent, engine: "claude-sdk", tools, ... });
 *   const result = await runner.think("Analyze this file", history);
 */
export class AgentRunner {
  readonly agent: AgentRecord;
  readonly engine: LLMEngine;
  private tools: ToolDefinition[];
  private systemPrompt: string;
  private executeTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  private maxToolLoops: number;

  constructor(config: AgentRunnerConfig) {
    this.agent = config.agent;
    this.engine = config.engine;
    this.tools = config.tools;
    this.systemPrompt = config.systemPrompt;
    this.executeTool = config.executeTool;
    this.maxToolLoops = config.maxToolLoops ?? 5;
  }

  /**
   * Agent thinks about a message, optionally calls tools, returns response.
   */
  async think(
    userMessage: string,
    conversationHistory: { role: string; content: string }[] = [],
  ): Promise<ThinkResult> {
    const prefix = `[Agent:${this.agent.name}]`;
    console.error(`${prefix} Thinking (engine: ${this.engine})...`);

    const allToolResults: ToolResult[] = [];
    let currentHistory = [...conversationHistory];
    let currentMessage = userMessage;

    for (let loop = 0; loop < this.maxToolLoops; loop++) {
      const response = await this.callLLM(currentMessage, currentHistory);

      // Parse tool calls from response
      const toolCalls = this.parseToolCalls(response);

      if (toolCalls.length === 0) {
        // No tools — final text response
        const cleanText = response.replace(/```tool_calls[\s\S]*?```/g, "").trim();
        console.error(`${prefix} Done (${loop} tool loops)`);
        return { text: cleanText, toolCalls: allToolResults };
      }

      // Execute each tool
      console.error(`${prefix} Tool loop ${loop + 1}: ${toolCalls.map(t => t.tool).join(", ")}`);

      const toolResults: { tool: string; args: Record<string, unknown>; result: unknown }[] = [];
      for (const tc of toolCalls) {
        console.error(`${prefix} → ${tc.tool}(${JSON.stringify(tc.args).substring(0, 80)})`);
        try {
          const result = await this.executeTool(tc.tool, tc.args);
          toolResults.push({ tool: tc.tool, args: tc.args, result });
          allToolResults.push({ tool: tc.tool, args: tc.args, result });
          console.error(`${prefix}   ✓ ${tc.tool} (${JSON.stringify(result).substring(0, 100)})`);
        } catch (err: any) {
          const errorResult = { error: err.message };
          toolResults.push({ tool: tc.tool, args: tc.args, result: errorResult });
          allToolResults.push({ tool: tc.tool, args: tc.args, result: errorResult });
          console.error(`${prefix}   ✗ ${tc.tool}: ${err.message}`);
        }
      }

      // Feed tool results back as next message
      const toolResultText = toolResults
        .map(r => `[Tool: ${r.tool}] Result:\n${JSON.stringify(r.result, null, 2)}`)
        .join("\n\n");

      currentHistory = [
        ...currentHistory,
        { role: "user", content: currentMessage },
        { role: "assistant", content: response },
      ];
      currentMessage = toolResultText;
    }

    // Max loops reached
    console.error(`${prefix} Max tool loops (${this.maxToolLoops}) reached`);
    return { text: "Đã đạt giới hạn xử lý. Vui lòng thử lại.", toolCalls: allToolResults };
  }

  /**
   * Call the LLM — route to the right engine.
   */
  private async callLLM(
    userMessage: string,
    history: { role: string; content: string }[],
  ): Promise<string> {
    if (this.engine === "claude-cli") {
      return this.callClaudeCLI(userMessage, history);
    }
    return this.callFastAPI(userMessage, history);
  }

  /**
   * Claude CLI — uses Max subscription via `claude --print`.
   * Free with Max account. Forces tool_calls output format.
   */
  private async callClaudeCLI(
    userMessage: string,
    history: { role: string; content: string }[],
  ): Promise<string> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const prompt = this.buildPromptWithHistory(userMessage, history);

    const toolReminder = `

BẮT BUỘC TUÂN THỦ:
1. Khi cần data (xem, tạo, sửa, xoá đơn/file/user) → OUTPUT tool_calls block TRƯỚC, KHÔNG trả lời text
2. Format BẮT BUỘC:
\`\`\`tool_calls
[{"tool":"tên_tool","args":{"key":"value"}}]
\`\`\`
3. KHÔNG BAO GIỜ tự bịa/giả data. Nếu chưa gọi tool → chưa có data → PHẢI gọi tool
4. Chỉ trả lời text khi: chào hỏi, giải thích chung, hoặc đã có tool result`;

    const fullPrompt = `${this.systemPrompt}${toolReminder}\n\n---\n\n${prompt}`;

    await acquireCLI();
    console.error(`[Agent:${this.agent.name}] CLI slot acquired (${_cliRunning}/${MAX_CONCURRENT_CLI}, queued: ${_cliQueue.length})`);

    try {
      const child = execFileAsync(
        "claude",
        ["--print", "--output-format", "text", "--max-turns", "1"],
        {
          encoding: "utf-8",
          timeout: 60_000,
          cwd: "/tmp",
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      // Write prompt to stdin
      child.child.stdin?.write(fullPrompt);
      child.child.stdin?.end();

      const { stdout } = await child;
      return (stdout ?? "").trim();
    } catch (err: any) {
      throw new Error(`Claude CLI failed: ${err.message?.substring(0, 200)}`);
    } finally {
      releaseCLI();
    }
  }

  /**
   * Fast API (OpenAI-compatible) — quick responses.
   */
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
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
        signal: controller.signal,
      });

      if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
      const data = (await resp.json()) as any;
      return data.choices?.[0]?.message?.content ?? "Không có phản hồi.";
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Build a flat prompt string from history + current message.
   * Used for Claude SDK which takes a single prompt string.
   */
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

  /**
   * Parse tool calls from LLM response text.
   * Format: ```tool_calls\n[{"tool":"name","args":{...}}]\n```
   */
  private parseToolCalls(text: string): { tool: string; args: Record<string, unknown> }[] {
    const patterns = [
      /```tool_calls\s*\n?([\s\S]*?)```/,
      /```json\s*\n?(\[[\s\S]*?\])\s*```/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        try {
          const parsed = JSON.parse(match[1].trim());
          if (Array.isArray(parsed)) {
            return parsed
              .filter((c: any) => c.tool && typeof c.tool === "string")
              .map((c: any) => ({ tool: c.tool, args: c.args ?? {} }));
          }
        } catch {}
      }
    }
    return [];
  }

  /**
   * Update the system prompt (e.g., inject knowledge context).
   */
  updateSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }
}
