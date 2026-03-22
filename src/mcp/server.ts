/**
 * MCP Server — exposes OpenClaw tools to external AI clients.
 *
 * Uses the SAME executeTool registry as the Telegram bot.
 * No duplicate tool definitions.
 *
 * Connect via: Claude Desktop, VS Code, or any MCP-compatible client.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Tool definitions — descriptions for MCP clients to discover
const TOOLS: { name: string; desc: string; args: Record<string, any> }[] = [
  // Business
  { name: "list_workflows", desc: "Xem danh sách quy trình", args: {} },
  { name: "create_workflow", desc: "Tạo quy trình mới", args: { name: z.string(), description: z.string().optional(), domain: z.string().optional(), stages: z.array(z.object({ id: z.string().optional(), name: z.string(), type: z.string().optional() })) } },
  { name: "create_form", desc: "Tạo form mới", args: { name: z.string(), fields: z.array(z.any()).optional() } },
  { name: "create_rule", desc: "Tạo business rule", args: { name: z.string(), domain: z.string().optional(), rule_type: z.string().optional(), conditions: z.any().optional(), actions: z.any().optional() } },
  { name: "save_tutorial", desc: "Lưu tutorial", args: { title: z.string(), content: z.string(), target_role: z.string().optional(), domain: z.string().optional() } },
  { name: "save_knowledge", desc: "Lưu knowledge", args: { type: z.string().optional(), title: z.string(), content: z.string(), domain: z.string().optional(), tags: z.array(z.string()).optional() } },
  { name: "search_knowledge", desc: "Tìm knowledge", args: { domain: z.string().optional(), tags: z.array(z.string()).optional() } },

  // Files
  { name: "list_files", desc: "Xem file đã upload", args: { limit: z.number().optional() } },
  { name: "read_file_content", desc: "Đọc nội dung file (PDF/DOCX/XLSX/TXT)", args: { file_id: z.string() } },
  { name: "get_file", desc: "Xem metadata file", args: { file_id: z.string() } },
  { name: "send_file", desc: "Gửi file cho user", args: { file_id: z.string() } },
  { name: "analyze_image", desc: "Phân tích ảnh (vision)", args: { file_id: z.string(), prompt: z.string().optional() } },

  // Collections (dynamic tables)
  { name: "create_collection", desc: "Tạo bảng dữ liệu mới", args: { name: z.string(), description: z.string().optional(), fields: z.array(z.any()).optional() } },
  { name: "list_collections", desc: "Xem danh sách bảng", args: {} },
  { name: "add_row", desc: "Thêm dòng vào bảng", args: { collection: z.string(), data: z.record(z.any()) } },
  { name: "list_rows", desc: "Xem dữ liệu trong bảng", args: { collection: z.string(), limit: z.number().optional(), offset: z.number().optional(), keyword: z.string().optional() } },
  { name: "update_row", desc: "Cập nhật dòng", args: { row_id: z.string(), data: z.record(z.any()) } },
  { name: "delete_row", desc: "Xoá dòng", args: { row_id: z.string() } },
  { name: "search_all", desc: "Tìm kiếm across tất cả bảng", args: { keyword: z.string().optional(), limit: z.number().optional() } },

  // Users & Permissions
  { name: "list_users", desc: "Xem danh sách users", args: {} },
  { name: "set_user_role", desc: "Đổi role user", args: { channel_user_id: z.string(), role: z.string(), channel: z.string().optional() } },
  { name: "db_query", desc: "Generic DB query (permission-checked)", args: { table: z.string(), action: z.string(), filter: z.record(z.any()).optional(), data: z.record(z.any()).optional() } },

  // Agents
  { name: "list_agents", desc: "Xem agents đang chạy", args: { role: z.string().optional(), status: z.string().optional() } },
  { name: "list_agent_templates", desc: "Xem agent templates", args: { role: z.string().optional() } },
  { name: "create_agent_template", desc: "Tạo template agent mới", args: { name: z.string(), role: z.string(), system_prompt: z.string(), capabilities: z.array(z.string()).optional(), tools: z.array(z.string()).optional() } },
  { name: "spawn_agent", desc: "Tạo agent từ template", args: { template_name: z.string().optional(), template_id: z.string().optional(), count: z.number().optional() } },
  { name: "kill_agent", desc: "Tắt agent", args: { agent_id: z.string() } },

  // System
  { name: "get_dashboard", desc: "Dashboard hệ thống", args: {} },
  { name: "get_ai_config", desc: "Xem AI config", args: {} },
  { name: "update_ai_config", desc: "Cập nhật AI config", args: { rules: z.array(z.string()).optional(), bot_name: z.string().optional(), custom_instructions: z.string().optional() } },
];

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "openclaw",
    version: "0.5.0",
  });

  // Register all tools from the shared registry
  for (const tool of TOOLS) {
    server.tool(
      tool.name,
      tool.desc,
      tool.args,
      async (args: Record<string, unknown>) => {
        // Lazy import to avoid circular dependency
        const { executeTool } = await import("../bot/agent-bridge.js");
        const { getConfig } = await import("../config.js");
        const tenantId = getConfig().TELEGRAM_DEFAULT_TENANT_ID ?? "";

        try {
          const result = await executeTool(tool.name, args, tenantId);
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

  console.error(`[MCP] Registered ${TOOLS.length} tools (shared registry)`);
  return server;
}
