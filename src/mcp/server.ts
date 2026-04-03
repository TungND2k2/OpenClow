/**
 * MCP Server — auto-registers ALL tools from tool-registry.
 * No duplicate definitions. Registry = single source of truth.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRegisteredTools } from "../bot/tool-registry.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "openclaw",
    version: "0.6.0",
  });

  // Auto-register ALL tools from the shared registry
  const toolNames = getRegisteredTools();

  for (const name of toolNames) {
    // Generic args schema — accept any JSON object
    server.tool(
      name,
      `OpenClaw tool: ${name}`,
      { input: z.record(z.any()).optional().describe("Tool arguments as key-value pairs") },
      async (params: Record<string, unknown>) => {
        const { executeTool } = await import("../bot/tool-registry.js");
        const { getConfig } = await import("../config.js");
        const tenantId = getConfig().TELEGRAM_DEFAULT_TENANT_ID ?? "";
        // Unwrap: SDK may send {input: {key: val}} or {key: val} directly
        const args = (params.input as Record<string, unknown>) ?? params;

        console.error(`[MCP] Tool: ${name} | Args: ${JSON.stringify(args).substring(0, 200)}`);
        try {
          const result = await executeTool(name, args, tenantId, {
            sessionId: "",
            currentUser: { id: "mcp", name: "MCP Client", role: "admin" },
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          console.error(`[MCP] Error: ${name} → ${err.message}`);
          return {
            content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      },
    );
  }

  console.error(`[MCP] Registered ${toolNames.length} tools (from registry)`);
  return server;
}
