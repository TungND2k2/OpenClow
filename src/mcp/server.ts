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
      { args: z.record(z.any()).optional() },
      async (params: Record<string, unknown>) => {
        const { executeTool } = await import("../bot/tool-registry.js");
        const { getConfig } = await import("../config.js");
        const tenantId = getConfig().TELEGRAM_DEFAULT_TENANT_ID ?? "";
        const args = (params.args as Record<string, unknown>) ?? params;

        try {
          const result = await executeTool(name, args, tenantId, {
            sessionId: "",
            currentUser: { id: "mcp", name: "MCP Client", role: "admin" },
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
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
