/**
 * Agent Bridge — connects Telegram to the FULL OpenClaw agent system.
 *
 * Pipeline:
 * 1. Create Task in OpenClaw
 * 2. Check Knowledge Base (learned from past interactions)
 * 3. If knowledge found → use it, skip LLM for simple queries
 * 4. If not → call LLM with tools
 * 5. Execute tools (DB operations)
 * 6. After response → extract knowledge, save for future
 * 7. Update task status, agent performance
 */

import { getDb } from "../db/connection.js";
import { eq, and } from "drizzle-orm";
import { notebookWrite } from "../modules/notebooks/notebook.service.js";
import { storeKnowledge, retrieveKnowledge } from "../modules/knowledge/knowledge.service.js";
import { getDashboard } from "../modules/monitoring/monitor.service.js";
import { startWorkflow } from "../modules/workflows/workflow-engine.service.js";
import { getFile, listFiles, readFileContent } from "../modules/storage/s3.service.js";
import { getQueueMetrics } from "./telegram.bot.js";
import { recordDecision } from "../modules/decisions/decision.service.js";
import {
  workflowTemplates, formTemplates, businessRules,
  tenantUsers,
} from "../db/schema.js";
import { newId } from "../utils/id.js";
import { nowMs } from "../utils/clock.js";
import { processMessage } from "./llm-client.js";

// ── Execute tool calls ───────────────────────────────────────

async function executeTool(tool: string, args: Record<string, unknown>, tenantId: string): Promise<unknown> {
  const db = getDb();
  const now = nowMs();

  switch (tool) {
    case "list_workflows": {
      return db.select({ id: workflowTemplates.id, name: workflowTemplates.name, description: workflowTemplates.description, domain: workflowTemplates.domain })
        .from(workflowTemplates)
        .where(and(eq(workflowTemplates.tenantId, tenantId), eq(workflowTemplates.status, "active")))
        .all();
    }

    case "create_workflow": {
      const id = newId();
      const stages = ((args.stages as any[]) ?? []).map((s: any, i: number) => ({
        id: s.id ?? `step_${i + 1}`, name: s.name, type: s.type ?? "form",
        next_stage_id: s.next_stage_id ?? (i < (args.stages as any[]).length - 1 ? (args.stages as any[])[i + 1]?.id ?? `step_${i + 2}` : undefined),
      }));
      db.insert(workflowTemplates).values({
        id, tenantId, name: args.name as string, description: (args.description as string) ?? null,
        domain: (args.domain as string) ?? null, version: 1, stages: JSON.stringify(stages),
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
        id, tenantId, name: args.name as string, description: (args.description as string) ?? null,
        domain: (args.domain as string) ?? null, ruleType: (args.rule_type as any) ?? "validation",
        conditions: JSON.stringify(args.conditions ?? {}), actions: JSON.stringify(args.actions ?? []),
        priority: (args.priority as number) ?? 0, status: "active", createdAt: now, updatedAt: now,
      }).run();
      return { id, name: args.name };
    }

    case "save_tutorial": {
      storeKnowledge({
        type: "procedure", title: args.title as string, content: args.content as string,
        domain: (args.domain as string) ?? "general", tags: ["tutorial", (args.target_role as string) ?? "general"],
        sourceAgentId: "system", scope: `domain:${(args.target_role as string) ?? "general"}`,
      });
      notebookWrite({
        namespace: `tutorial:${tenantId}`, key: (args.title as string).toLowerCase().replace(/\s+/g, "-"),
        value: args.content as string, contentType: "text/markdown",
      });
      return { saved: true, title: args.title };
    }

    case "save_knowledge": {
      const entry = storeKnowledge({
        type: (args.type as any) ?? "domain_knowledge", title: args.title as string,
        content: args.content as string, domain: (args.domain as string) ?? "general",
        tags: (args.tags as string[]) ?? [], sourceAgentId: "system",
      });
      return { id: entry.id, title: entry.title };
    }

    case "list_tutorials": {
      return retrieveKnowledge({ tags: ["tutorial"], capabilities: [], domain: (args.domain as string) ?? "general", limit: 10 })
        .map(r => ({ title: r.title, domain: r.domain, content: r.content.substring(0, 200) + "..." }));
    }

    case "start_workflow_instance": {
      const instance = startWorkflow({
        templateId: args.template_id as string, tenantId,
        initiatedBy: (args.initiated_by as string) ?? "telegram", channel: "telegram",
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
        tags: (args.tags as string[]) ?? [], capabilities: [],
        domain: (args.domain as string) ?? "general", limit: 5,
      }).map(r => ({ title: r.title, content: r.content.substring(0, 200), score: r.matchScore }));
    }

    case "read_file_content": {
      let fileId = args.file_id as string;
      if (fileId && !fileId.startsWith("01")) {
        const allFiles = listFiles(tenantId, 50);
        const match = allFiles.find((f: any) => f.fileName.toLowerCase().includes(fileId.toLowerCase()));
        if (match) fileId = match.id;
      }
      const result = await readFileContent(fileId);
      if (!result) return { error: "File not found or cannot read" };
      return { fileName: result.fileName, content: result.content, truncated: result.truncated };
    }

    case "send_file": {
      const file = getFile(args.file_id as string);
      if (!file) return { error: "File not found" };
      return { __send_file__: true, url: file.s3Url, fileName: file.fileName, mimeType: file.mimeType };
    }

    case "list_files": return listFiles(tenantId, (args.limit as number) ?? 20);
    case "get_file": return getFile(args.file_id as string);

    case "set_user_role": {
      const existing = db.select({ id: tenantUsers.id }).from(tenantUsers)
        .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.channel, args.channel as string), eq(tenantUsers.channelUserId, args.channel_user_id as string))).get();
      if (existing) {
        db.update(tenantUsers).set({ role: args.role as any, displayName: (args.display_name as string) ?? undefined, updatedAt: now })
          .where(eq(tenantUsers.id, existing.id)).run();
      } else {
        db.insert(tenantUsers).values({
          id: newId(), tenantId, channel: args.channel as string, channelUserId: args.channel_user_id as string,
          displayName: (args.display_name as string) ?? null, role: (args.role as any) ?? "user", isActive: 1, createdAt: now, updatedAt: now,
        }).run();
      }
      return { success: true, role: args.role };
    }

    case "list_users": {
      return db.select({ channelUserId: tenantUsers.channelUserId, channel: tenantUsers.channel, displayName: tenantUsers.displayName, role: tenantUsers.role })
        .from(tenantUsers).where(eq(tenantUsers.tenantId, tenantId)).all();
    }

    default: return { error: `Unknown tool: ${tool}` };
  }
}

// ── Commander Pipeline (uses full agent system) ──────────────

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

  // ── Step 1: Track interaction ────────────────────────────────
  const interactionId = newId();
  console.error(`[Pipeline] Interaction: ${interactionId}`);

  // ── Step 2: Query Knowledge Base ───────────────────────────
  const keywords = input.userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const knowledge = retrieveKnowledge({
    tags: keywords,
    capabilities: [],
    domain: "general",
    scope: ["global", `domain:sales`, `domain:general`],
    limit: 3,
  });

  let knowledgeContext = "";
  if (knowledge.length > 0 && knowledge[0].matchScore > 0.3) {
    console.error(`[Pipeline] Knowledge found: ${knowledge.length} entries (top score: ${knowledge[0].matchScore.toFixed(2)})`);
    knowledgeContext = `\n\nKNOWLEDGE BASE (thông tin đã học, ưu tiên dùng nếu liên quan):\n${knowledge.map(k => `[${k.type}] ${k.title}: ${k.content.substring(0, 300)}`).join("\n\n")}`;
  } else {
    console.error(`[Pipeline] No relevant knowledge found`);
  }

  // ── Step 3: Build context with files + knowledge ───────────
  const uploadedFiles = listFiles(input.tenantId, 20);
  const fileContext = uploadedFiles.length > 0
    ? `\n\nFILES ĐÃ UPLOAD:\n${uploadedFiles.map((f: any) => `• ${f.fileName} (ID: ${f.id})`).join("\n")}\nKhi user hỏi về nội dung file/cẩm nang/tài liệu → gọi read_file_content(file_id) để đọc, KHÔNG tự bịa.`
    : "";

  const systemPrompt = buildCommanderPrompt(input.tenantName, input.userName, input.userRole, input.aiConfig) + knowledgeContext + fileContext;

  // ── Step 4: Call LLM with tools ────────────────────────────
  try {
    const result = await processMessage({
      userMessage: input.userMessage,
      systemPrompt,
      conversationHistory: input.conversationHistory,
      executeTool: async (tool, args) => {
        console.error(`[Pipeline] Tool: ${tool}`);
        const toolResult = await executeTool(tool, args, input.tenantId);

        if (toolResult && typeof toolResult === "object" && (toolResult as any).__send_file__) {
          _files.push({ url: (toolResult as any).url, fileName: (toolResult as any).fileName, mimeType: (toolResult as any).mimeType });
        }
        return toolResult;
      },
    });

    // ── Step 5: Extract & save knowledge (self-learning) ──────
    if (result.toolResults.length > 0) {
      const toolNames = result.toolResults.map(t => t.tool).join(", ");
      try {
        storeKnowledge({
          type: "best_practice",
          title: `Q: ${input.userMessage.substring(0, 80)}`,
          content: `User: "${input.userMessage}"\nTools: ${toolNames}\nAnswer: ${result.text.substring(0, 500)}`,
          domain: "general",
          tags: [...keywords.slice(0, 5), ...result.toolResults.map(t => t.tool)],
          sourceAgentId: "system",
          outcome: "success",
        });
        console.error(`[Pipeline] ✓ Knowledge saved (${toolNames})`);
      } catch (ke: any) {
        console.error(`[Pipeline] Knowledge save failed: ${ke.message}`);
      }
    }

    // Record decision (audit)
    recordDecision({
      agentId: "system",
      decisionType: "assign",
      reasoning: `Chat: "${input.userMessage.substring(0, 60)}". Tools: ${result.toolResults.map(t => t.tool).join(", ") || "none"}. Knowledge hits: ${knowledge.length}.`,
    });

    const elapsed = Date.now() - startTime;
    console.error(`[Pipeline] ─── END (${elapsed}ms) ────────────`);

    return { text: result.text, files: _files };
  } catch (e: any) {
    // Save failure as anti-pattern knowledge
    try {
      storeKnowledge({
        type: "anti_pattern",
        title: `Failed: ${input.userMessage.substring(0, 80)}`,
        content: `Error: ${e.message}`,
        domain: "general",
        tags: keywords.slice(0, 5),
        sourceAgentId: "system",
        outcome: "failure",
      });
    } catch {}

    console.error(`[Pipeline] ✗ Error (${Date.now() - startTime}ms): ${e.message}`);
    return { text: `⚠️ Lỗi: ${e.message}`, files: _files };
  }
}

// ── System prompt ────────────────────────────────────────────

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
8. read_file_content(file_id) — Đọc nội dung file (DOCX/TXT/CSV) — DÙNG KHI USER HỎI VỀ NỘI DUNG FILE
9. get_file(file_id) — Xem metadata file
10. send_file(file_id) — Gửi file cho user
11. list_users() — Xem users
12. set_user_role(channel, channel_user_id, role) — Đổi role
13. get_dashboard() — Dashboard hệ thống
14. search_knowledge(domain?, tags?) — Tìm knowledge đã học

Cách gọi tool:
\`\`\`tool_calls
[{"tool":"read_file_content","args":{"file_id":"..."}}]
\`\`\`

QUY TẮC QUAN TRỌNG:
• Khi có KNOWLEDGE BASE bên dưới → ƯU TIÊN dùng, trả lời nhanh
• Khi user hỏi về file/cẩm nang/tài liệu → gọi read_file_content, trả lời từ NỘI DUNG THỰC TẾ
• KHÔNG tự bịa nội dung — phải dựa trên dữ liệu thật (knowledge/file/DB)
• Ngắn gọn, thực tế, đúng trọng tâm câu hỏi

${customInstructions}`.trim();
}
