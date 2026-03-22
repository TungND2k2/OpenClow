import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getConfig } from "../config.js";
import { recordUsage, checkBudget } from "./cost.tracker.js";
import { getAgent } from "../modules/agents/agent.service.js";

let _server: ReturnType<typeof createServer> | null = null;

/**
 * Determine which API endpoint to use based on agent role.
 * Commander → Anthropic API (Claude Max)
 * Workers/Specialists → Cheap OpenAI-compatible API
 */
async function getRouting(agentId: string): Promise<{
  targetUrl: string;
  apiKey: string | undefined;
  model: string;
  format: "anthropic" | "openai";
}> {
  const config = getConfig();
  const agent = agentId ? await getAgent(agentId) : null;

  if (agent?.role === "commander" || agent?.role === "supervisor") {
    return {
      targetUrl: config.COMMANDER_API_BASE,
      apiKey: config.COMMANDER_API_KEY,
      model: config.COMMANDER_MODEL,
      format: "anthropic",
    };
  }

  // Workers & specialists → cheap API
  if (config.WORKER_API_BASE) {
    return {
      targetUrl: config.WORKER_API_BASE,
      apiKey: config.WORKER_API_KEY,
      model: config.WORKER_MODEL,
      format: "openai",
    };
  }

  // Fallback to commander API
  return {
    targetUrl: config.COMMANDER_API_BASE,
    apiKey: config.COMMANDER_API_KEY,
    model: config.COMMANDER_MODEL,
    format: "anthropic",
  };
}

/**
 * Transform Anthropic-format request to OpenAI-format if needed.
 */
function toOpenAIFormat(body: any, model: string): any {
  return {
    model,
    messages: (body.messages ?? []).map((m: any) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string"
        ? m.content
        : (m.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n"),
    })),
    max_tokens: body.max_tokens ?? 4096,
    temperature: body.temperature ?? 0.7,
    stream: false,
  };
}

/**
 * Extract token counts from response based on format.
 */
function extractUsage(
  responseJson: any,
  format: "anthropic" | "openai"
): { inputTokens: number; outputTokens: number } {
  if (format === "anthropic" && responseJson?.usage) {
    return {
      inputTokens: responseJson.usage.input_tokens ?? 0,
      outputTokens: responseJson.usage.output_tokens ?? 0,
    };
  }
  if (format === "openai" && responseJson?.usage) {
    return {
      inputTokens: responseJson.usage.prompt_tokens ?? 0,
      outputTokens: responseJson.usage.completion_tokens ?? 0,
    };
  }
  return { inputTokens: 0, outputTokens: 0 };
}

/**
 * Start the LLM API proxy server.
 *
 * Usage by agents:
 *   POST http://127.0.0.1:{PROXY_PORT}/v1/messages
 *   Headers:
 *     x-agent-id: <agent_id>
 *     x-task-id: <task_id> (optional)
 *   Body: Anthropic API format
 *
 * The proxy automatically routes to the right backend based on agent role.
 */
export function startProxy(): void {
  if (_server) return;
  const config = getConfig();
  const port = config.PROXY_PORT;
  if (!port) {
    console.error("[Proxy] No PROXY_PORT configured, skipping");
    return;
  }

  _server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (req.method !== "POST") { res.writeHead(405); res.end("Method not allowed"); return; }

    try {
      // Read body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const bodyStr = Buffer.concat(chunks).toString();
      const body = JSON.parse(bodyStr);

      const agentId = req.headers["x-agent-id"] as string ?? "";
      const taskId = req.headers["x-task-id"] as string | undefined;

      // Budget check
      if (agentId) {
        const budget = await checkBudget(agentId);
        if (!budget.withinBudget) {
          res.writeHead(402, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Budget exceeded", spent: budget.spent, budget: budget.budget }));
          return;
        }
      }

      // Route based on agent role
      const routing = await getRouting(agentId);
      const model = body.model ?? routing.model;

      let targetUrl: string;
      let requestBody: string;
      let headers: Record<string, string> = { "Content-Type": "application/json" };

      if (routing.format === "openai") {
        // OpenAI-compatible endpoint
        targetUrl = `${routing.targetUrl}/chat/completions`;
        requestBody = JSON.stringify(toOpenAIFormat(body, model));
        if (routing.apiKey) headers["Authorization"] = `Bearer ${routing.apiKey}`;
      } else {
        // Anthropic API
        targetUrl = `${routing.targetUrl}/v1/messages`;
        requestBody = JSON.stringify({ ...body, model });
        headers["anthropic-version"] = "2023-06-01";
        if (routing.apiKey) headers["x-api-key"] = routing.apiKey;
      }

      console.error(`[Proxy] ${agentId || "unknown"} → ${routing.format}/${model}`);

      const proxyRes = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(120000),
      });

      const responseBody = await proxyRes.text();
      let responseJson: any;
      try { responseJson = JSON.parse(responseBody); } catch { responseJson = null; }

      // Record token usage
      if (agentId && responseJson) {
        const usage = extractUsage(responseJson, routing.format);
        if (usage.inputTokens > 0 || usage.outputTokens > 0) {
          await recordUsage({
            agentId,
            taskId,
            model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          });
        }
      }

      res.writeHead(proxyRes.status, { "Content-Type": "application/json" });
      res.end(responseBody);
    } catch (e: any) {
      console.error("[Proxy] Error:", e.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  _server.listen(port, "127.0.0.1", () => {
    console.error(`[Proxy] Listening on http://127.0.0.1:${port}`);
    console.error(`[Proxy] Commander → ${config.COMMANDER_API_BASE} (${config.COMMANDER_MODEL})`);
    if (config.WORKER_API_BASE) {
      console.error(`[Proxy] Workers → ${config.WORKER_API_BASE} (${config.WORKER_MODEL})`);
    }
  });
}

/**
 * Stop the proxy server.
 */
export function stopProxy(): void {
  if (_server) {
    _server.close();
    _server = null;
    console.error("[Proxy] Stopped");
  }
}
