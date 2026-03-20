import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as msgService from "../../modules/messaging/message.service.js";

export function registerMessageTools(server: McpServer): void {
  server.tool("send_message", "Send message to another agent", {
    from_agent_id: z.string(),
    to_agent_id: z.string().optional(),
    type: z.enum(["command", "report", "request", "broadcast", "escalation", "coordination"]),
    task_id: z.string().optional(),
    payload: z.record(z.unknown()),
    priority: z.number().optional(),
  }, async (params) => {
    const msg = await msgService.sendMessage({
      fromAgentId: params.from_agent_id,
      toAgentId: params.to_agent_id,
      type: params.type,
      taskId: params.task_id,
      payload: params.payload,
      priority: params.priority,
    });
    return { content: [{ type: "text", text: JSON.stringify(msg, null, 2) }] };
  });

  server.tool("check_messages", "Poll pending messages for an agent", {
    agent_id: z.string(),
    type: z.enum(["command", "report", "request", "broadcast", "escalation", "coordination"]).optional(),
    since: z.number().optional(),
    limit: z.number().optional(),
  }, async (params) => {
    const msgs = await msgService.checkMessages({
      agentId: params.agent_id,
      type: params.type,
      since: params.since,
      limit: params.limit,
    });
    return { content: [{ type: "text", text: JSON.stringify(msgs, null, 2) }] };
  });

  server.tool("acknowledge_message", "Mark message as handled", {
    message_id: z.string(),
    agent_id: z.string(),
  }, async ({ message_id, agent_id }) => {
    try {
      await msgService.acknowledgeMessage(message_id, agent_id);
      return { content: [{ type: "text", text: "OK" }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  });

  server.tool("broadcast", "Send to all agents in scope", {
    from_agent_id: z.string(),
    scope: z.string().describe("'all' | 'subordinates' | 'level:worker' etc"),
    payload: z.record(z.unknown()),
    task_id: z.string().optional(),
  }, async (params) => {
    const msgs = await msgService.broadcast(params.from_agent_id, params.scope, params.payload, params.task_id);
    return { content: [{ type: "text", text: `Broadcast sent to ${msgs.length} agents` }] };
  });
}
