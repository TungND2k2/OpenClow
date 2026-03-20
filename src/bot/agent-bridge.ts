/**
 * Agent Bridge — connects Telegram messages to the OpenClaw agent system.
 *
 * Bot is ONLY a transport layer:
 * 1. Receive message from Telegram
 * 2. Create a task in OpenClaw for the Commander
 * 3. Commander (powered by LLM) understands intent
 * 4. Commander decomposes into subtasks, delegates to workers
 * 5. Workers execute via MCP tools (create_workflow, store_knowledge, etc.)
 * 6. Result flows back to user
 *
 * NO hardcoded intents. NO regex matching. Commander decides everything.
 */

import { getConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import { eq, and } from "drizzle-orm";
import { notebookWrite, notebookRead, notebookList } from "../modules/notebooks/notebook.service.js";
import { storeKnowledge, retrieveKnowledge } from "../modules/knowledge/knowledge.service.js";
import { getDashboard } from "../modules/monitoring/monitor.service.js";
import { startWorkflow } from "../modules/workflows/workflow-engine.service.js";
import { getFile, listFiles, readFileContent } from "../modules/storage/s3.service.js";
import { getQueueMetrics } from "./telegram.bot.js";
import {
  workflowTemplates, formTemplates, businessRules,
  workflowInstances, tenants, tenantUsers,
} from "../db/schema.js";
import { newId } from "../utils/id.js";
import { nowMs } from "../utils/clock.js";

// ── Execute tool calls ───────────────────────────────────────

async function executeTool(tool: string, args: Record<string, unknown>, tenantId: string): Promise<unknown> {
  const db = getDb();
  const now = nowMs();

  switch (tool) {
    case "list_workflows": {
      const rows = db.select({ id: workflowTemplates.id, name: workflowTemplates.name, description: workflowTemplates.description })
        .from(workflowTemplates)
        .where(and(eq(workflowTemplates.tenantId, tenantId), eq(workflowTemplates.status, "active")))
        .all();
      return rows;
    }

    case "create_workflow": {
      const id = newId();
      const stages = ((args.stages as any[]) ?? []).map((s: any, i: number) => ({
        id: s.id ?? `step_${i + 1}`,
        name: s.name,
        type: s.type ?? "form",
        next_stage_id: s.next_stage_id ?? (i < (args.stages as any[]).length - 1 ? (args.stages as any[])[i + 1]?.id ?? `step_${i + 2}` : undefined),
        ...(s.form_id ? { form_id: s.form_id } : {}),
        ...(s.notification_config ? { notification_config: s.notification_config } : {}),
        ...(s.approval_config ? { approval_config: s.approval_config } : {}),
      }));
      db.insert(workflowTemplates).values({
        id, tenantId, name: args.name as string,
        description: (args.description as string) ?? null,
        domain: (args.domain as string) ?? null,
        version: 1, stages: JSON.stringify(stages),
        status: "active", createdAt: now, updatedAt: now,
      }).run();
      return { id, name: args.name, stageCount: stages.length };
    }

    case "create_form": {
      const id = newId();
      db.insert(formTemplates).values({
        id, tenantId, name: args.name as string,
        schema: JSON.stringify({ fields: args.fields ?? [] }),
        version: 1, status: "active", createdAt: now, updatedAt: now,
      }).run();
      return { id, name: args.name };
    }

    case "create_rule": {
      const id = newId();
      db.insert(businessRules).values({
        id, tenantId, name: args.name as string,
        description: (args.description as string) ?? null,
        domain: (args.domain as string) ?? null,
        ruleType: (args.rule_type as any) ?? "validation",
        conditions: JSON.stringify(args.conditions ?? {}),
        actions: JSON.stringify(args.actions ?? []),
        priority: (args.priority as number) ?? 0,
        status: "active", createdAt: now, updatedAt: now,
      }).run();
      return { id, name: args.name };
    }

    case "save_tutorial": {
      storeKnowledge({
        type: "procedure",
        title: args.title as string,
        content: args.content as string,
        domain: (args.domain as string) ?? "general",
        tags: ["tutorial", (args.target_role as string) ?? "general"],
        sourceAgentId: "system",
        scope: `domain:${(args.target_role as string) ?? "general"}`,
      });
      notebookWrite({
        namespace: `tutorial:${tenantId}`,
        key: (args.title as string).toLowerCase().replace(/\s+/g, "-"),
        value: args.content as string,
        contentType: "text/markdown",
      });
      return { saved: true, title: args.title };
    }

    case "save_knowledge": {
      const entry = storeKnowledge({
        type: (args.type as any) ?? "domain_knowledge",
        title: args.title as string,
        content: args.content as string,
        domain: (args.domain as string) ?? "general",
        tags: (args.tags as string[]) ?? [],
        sourceAgentId: "system",
      });
      return { id: entry.id, title: entry.title };
    }

    case "list_tutorials": {
      const results = retrieveKnowledge({
        tags: ["tutorial"],
        capabilities: [],
        domain: (args.domain as string) ?? "general",
        limit: 10,
      });
      return results.map(r => ({ title: r.title, domain: r.domain, content: r.content.substring(0, 100) + "..." }));
    }

    case "start_workflow_instance": {
      const instance = startWorkflow({
        templateId: args.template_id as string,
        tenantId,
        initiatedBy: (args.initiated_by as string) ?? "telegram",
        channel: "telegram",
      });
      return { instanceId: instance.id, status: instance.status };
    }

    case "get_dashboard": {
      const dash = getDashboard();
      const queueMetrics = getQueueMetrics?.() ?? null;
      return { ...dash, queue: queueMetrics };
    }

    case "search_knowledge": {
      return retrieveKnowledge({
        tags: (args.tags as string[]) ?? [],
        capabilities: [],
        domain: (args.domain as string) ?? "general",
        limit: 5,
      }).map(r => ({ title: r.title, content: r.content.substring(0, 200), score: r.matchScore }));
    }

    case "set_user_role": {
      const existingUser = db.select({ id: tenantUsers.id })
        .from(tenantUsers)
        .where(and(
          eq(tenantUsers.tenantId, tenantId),
          eq(tenantUsers.channel, args.channel as string),
          eq(tenantUsers.channelUserId, args.channel_user_id as string),
        )).get();

      if (existingUser) {
        db.update(tenantUsers).set({
          role: args.role as any,
          displayName: (args.display_name as string) ?? undefined,
          updatedAt: now,
        }).where(eq(tenantUsers.id, existingUser.id)).run();
      } else {
        const id = newId();
        db.insert(tenantUsers).values({
          id, tenantId,
          channel: args.channel as string,
          channelUserId: args.channel_user_id as string,
          displayName: (args.display_name as string) ?? null,
          role: (args.role as any) ?? "user",
          isActive: 1, createdAt: now, updatedAt: now,
        }).run();
      }
      return { success: true, role: args.role };
    }

    case "list_users": {
      return db.select({
        channelUserId: tenantUsers.channelUserId,
        channel: tenantUsers.channel,
        displayName: tenantUsers.displayName,
        role: tenantUsers.role,
      }).from(tenantUsers)
        .where(eq(tenantUsers.tenantId, tenantId))
        .all();
    }

    case "read_file_content": {
      const result = await readFileContent(args.file_id as string);
      if (!result) return { error: "File not found or cannot read" };
      return { fileName: result.fileName, mimeType: result.mimeType, content: result.content, truncated: result.truncated };
    }

    case "send_file": {
      const file = getFile(args.file_id as string);
      if (!file) return { error: "File not found" };
      return { __send_file__: true, url: file.s3Url, fileName: file.fileName, mimeType: file.mimeType };
    }

    case "list_files": {
      return listFiles(tenantId, (args.limit as number) ?? 20);
    }

    case "get_file": {
      return getFile(args.file_id as string);
    }

    case "respond": {
      return { message: args.message };
    }

    default:
      return { error: `Unknown tool: ${tool}` };
  }
}

// ── Commander LLM call (Claude Code SDK) ─────────────────────

import { processWithClaudeCLI } from "./llm-client.js";

export interface CommanderResponse {
  text: string;
  files: { url: string; fileName: string; mimeType: string }[];
}

export async function processWithCommander(input: {
  userMessage: string;
  userName: string;
  userId: string;
  userRole: string;
  tenantId: string;
  tenantName: string;
  conversationHistory: { role: string; content: string }[];
  aiConfig: Record<string, unknown>;
}): Promise<CommanderResponse> {
  const _files: CommanderResponse["files"] = [];
  const startTime = Date.now();

  console.error(`[Pipeline] ─── START ───────────────────────────`);
  console.error(`[Pipeline] User: ${input.userName} (${input.userRole})`);
  console.error(`[Pipeline] Message: "${input.userMessage}"`);
  console.error(`[Pipeline] Engine: Claude Code SDK`);

  const systemPrompt = buildCommanderPrompt(input.tenantName, input.userName, input.userRole, input.aiConfig);

  try {
    const result = await processWithClaudeCLI({
      userMessage: input.userMessage,
      systemPrompt,
      conversationHistory: input.conversationHistory,
      executeTool: async (tool, args) => {
        const toolResult = await executeTool(tool, args, input.tenantId);

        // Collect files to send
        if (toolResult && typeof toolResult === "object" && (toolResult as any).__send_file__) {
          _files.push({
            url: (toolResult as any).url,
            fileName: (toolResult as any).fileName,
            mimeType: (toolResult as any).mimeType,
          });
        }

        return toolResult;
      },
    });

    console.error(`[Pipeline] ─── END (${Date.now() - startTime}ms) ────────────`);
    return { text: result.text, files: _files };
  } catch (e: any) {
    console.error(`[Pipeline] ✗ Error (${Date.now() - startTime}ms): ${e.message}`);
    return { text: `⚠️ Lỗi: ${e.message}`, files: _files };
  }
}

// ── Commander system prompt ──────────────────────────────────

function buildCommanderPrompt(
  tenantName: string, userName: string, userRole: string,
  aiConfig: Record<string, unknown>
): string {
  const customInstructions = (aiConfig.system_prompt as string) ?? "";

  return `Bạn là Commander AI của ${tenantName}, vận hành trên OpenClaw.

USER: ${userName} | ROLE: ${userRole} | QUYỀN: ${userRole === "admin" || userRole === "manager" ? "ADMIN — tạo/sửa quy trình, tutorial, rules, quản lý user" : "USER — sử dụng quy trình có sẵn"}

Bạn có tools sau. Khi cần, output JSON block \`\`\`tool_calls để gọi:

Tools:
1. list_workflows() — Xem danh sách quy trình
2. create_workflow(name, description, domain, stages[{id,name,type}]) — Tạo quy trình
3. create_form(name, fields[{id,label,type,required}]) — Tạo form
4. create_rule(name, domain, rule_type, conditions, actions) — Tạo business rule
5. save_tutorial(title, content, target_role, domain) — Lưu tutorial
6. save_knowledge(type, title, content, domain, tags[]) — Lưu knowledge
7. list_files(limit?) — Xem file đã upload
8. read_file_content(file_id) — Đọc nội dung file (DOCX/TXT/CSV)
9. get_file(file_id) — Xem metadata file
10. send_file(file_id) — Gửi file cho user
11. list_users() — Xem danh sách users
12. set_user_role(channel, channel_user_id, role) — Đổi role user
13. get_dashboard() — Xem dashboard hệ thống
14. search_knowledge(domain?, tags?) — Tìm knowledge

Cách gọi tool — output block này:
\`\`\`tool_calls
[{"tool":"list_files","args":{}}]
\`\`\`

QUY TẮC:
• Khi user yêu cầu xem/tạo/sửa → PHẢI gọi tool, KHÔNG bịa
• Câu hỏi đơn giản → trả lời text, không cần tool
• KHÔNG nói "sẽ kiểm tra" rồi không làm — gọi tool ngay
• Ngắn gọn, rõ ràng

${customInstructions}`.trim();
}

