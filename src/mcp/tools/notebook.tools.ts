import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as nbService from "../../modules/notebooks/notebook.service.js";

export function registerNotebookTools(server: McpServer): void {
  server.tool("notebook_write", "Write or update a notebook entry", {
    namespace: z.string(),
    key: z.string(),
    value: z.string(),
    content_type: z.enum(["text/markdown", "application/json", "text/plain"]).optional(),
    agent_id: z.string().optional(),
  }, async (params) => {
    const entry = await nbService.notebookWrite({
      namespace: params.namespace,
      key: params.key,
      value: params.value,
      contentType: params.content_type,
      agentId: params.agent_id,
    });
    return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
  });

  server.tool("notebook_read", "Read a notebook entry", {
    namespace: z.string(),
    key: z.string(),
  }, async ({ namespace, key }) => {
    const entry = await nbService.notebookRead(namespace, key);
    if (!entry) return { content: [{ type: "text", text: "Not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
  });

  server.tool("notebook_list", "List entries in a namespace", {
    namespace: z.string(),
    key_prefix: z.string().optional(),
  }, async ({ namespace, key_prefix }) => {
    const list = await nbService.notebookList(namespace, key_prefix);
    return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
  });

  server.tool("notebook_delete", "Delete a notebook entry", {
    namespace: z.string(),
    key: z.string(),
  }, async ({ namespace, key }) => {
    const deleted = await nbService.notebookDelete(namespace, key);
    return { content: [{ type: "text", text: deleted ? "Deleted" : "Not found" }] };
  });
}
