/**
 * LLM Client — uses `claude` CLI (--print mode) with Max login.
 * Runs claude as subprocess, captures output.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LLMResponse {
  text: string;
}

/**
 * Call Claude via CLI --print mode.
 * Simple, reliable — no SDK import issues.
 */
export async function callClaude(
  systemPrompt: string,
  userMessage: string
): Promise<LLMResponse> {
  const startMs = Date.now();
  console.error(`[Claude CLI] Calling...`);

  try {
    const { stdout, stderr } = await execFileAsync("claude", [
      "--print",
      "--system-prompt", systemPrompt,
      userMessage,
    ], {
      timeout: 120000,
      maxBuffer: 1024 * 1024, // 1MB
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });

    const elapsed = Date.now() - startMs;
    const text = stdout.trim();
    console.error(`[Claude CLI] ✓ ${elapsed}ms — ${text.length} chars`);

    return { text };
  } catch (e: any) {
    const elapsed = Date.now() - startMs;
    console.error(`[Claude CLI] ✗ ${elapsed}ms — ${e.message}`);
    throw e;
  }
}

/**
 * Process with Claude including tool execution.
 * Claude generates text, we parse tool calls from output,
 * execute them, and call Claude again with results.
 */
export async function processWithClaudeCLI(input: {
  userMessage: string;
  systemPrompt: string;
  conversationHistory?: { role: string; content: string }[];
  executeTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}): Promise<{ text: string; toolResults: { tool: string; result: unknown }[] }> {
  const startMs = Date.now();
  const toolResults: { tool: string; result: unknown }[] = [];

  // Build context from history
  const historyContext = (input.conversationHistory ?? [])
    .slice(-10)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const fullSystem = historyContext
    ? `${input.systemPrompt}\n\nRecent conversation:\n${historyContext}`
    : input.systemPrompt;

  // First call
  let response = await callClaude(fullSystem, input.userMessage);
  let text = response.text;

  // Check for tool calls in response (```tool_calls blocks)
  let loopCount = 0;
  while (loopCount < 5) {
    const toolCalls = parseToolCalls(text);
    if (toolCalls.length === 0) break;

    loopCount++;
    console.error(`[Claude CLI] Tool loop ${loopCount}: ${toolCalls.map(t => t.tool).join(", ")}`);

    // Execute tools
    const results: string[] = [];
    for (const tc of toolCalls) {
      console.error(`[Claude CLI] → ${tc.tool}(${JSON.stringify(tc.args).substring(0, 100)})`);
      const result = await input.executeTool(tc.tool, tc.args);
      const resultStr = JSON.stringify(result);
      results.push(`Tool ${tc.tool} returned: ${resultStr}`);
      toolResults.push({ tool: tc.tool, result });
      console.error(`[Claude CLI]   ✓ ${tc.tool}: ${resultStr.substring(0, 100)}`);
    }

    // Follow-up with tool results
    const followUpMessage = `I called these tools:\n${results.join("\n")}\n\nNow provide the final response to the user based on these results.`;
    response = await callClaude(fullSystem, followUpMessage);
    text = response.text;
  }

  console.error(`[Claude CLI] Done (${Date.now() - startMs}ms, ${toolResults.length} tools)`);
  return { text, toolResults };
}

// ── Parse tool calls from text ───────────────────────────────

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

function parseToolCalls(content: string): ToolCall[] {
  const match = content.match(/```tool_calls\s*\n?([\s\S]*?)```/);
  if (match) {
    try {
      const calls = JSON.parse(match[1]);
      if (Array.isArray(calls)) return calls;
    } catch {}
  }

  const jsonMatch = content.match(/```json\s*\n?(\[[\s\S]*?\])```/);
  if (jsonMatch) {
    try {
      const calls = JSON.parse(jsonMatch[1]);
      if (Array.isArray(calls) && calls[0]?.tool) return calls;
    } catch {}
  }

  return [];
}

/**
 * Check if claude CLI is available.
 */
export function isClaudeAvailable(): boolean {
  try {
    require("child_process").execSync("claude --version", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
