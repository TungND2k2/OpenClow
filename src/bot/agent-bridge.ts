/**
 * Agent Bridge — connects Telegram to the FULL OpenClaw agent system.
 *
 * Pipeline (using REAL agents, not direct LLM calls):
 * 1. Create Task in DB (with valid FK to Commander agent)
 * 2. Check Knowledge Base (learned from past interactions)
 * 3. Commander agent thinks (Claude SDK or fast API)
 * 4. Commander calls tools → executes via tool registry
 * 5. After response → extract knowledge (self-learning)
 * 6. Update agent performance + task status
 */

import { getDb } from "../db/connection.js";
import { eq, and } from "drizzle-orm";
import { notebookWrite } from "../modules/notebooks/notebook.service.js";
import { storeKnowledge, retrieveKnowledge } from "../modules/knowledge/knowledge.service.js";
import { getDashboard } from "../modules/monitoring/monitor.service.js";
import { startWorkflow } from "../modules/workflows/workflow-engine.service.js";
import { getFile, listFiles, readFileContent } from "../modules/storage/s3.service.js";
import { getQueueMetrics } from "./telegram.bot.js";
import { createTask, assignTask, startTask, completeTask, failTask } from "../modules/tasks/task.service.js";
import { recordDecision } from "../modules/decisions/decision.service.js";
import { updatePerformance, heartbeat } from "../modules/agents/agent.service.js";
import { getCommander } from "../modules/agents/agent-pool.js";
import { AgentRunner } from "../modules/agents/agent-runner.js";
import {
  workflowTemplates, formTemplates, businessRules,
  tenantUsers,
} from "../db/schema.js";
import { newId } from "../utils/id.js";
import { nowMs } from "../utils/clock.js";

// ── Tool Registry ─────────────────────────────────────────────

export async function executeTool(tool: string, args: Record<string, unknown>, tenantId: string): Promise<unknown> {
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
      const commander = getCommander();
      storeKnowledge({
        type: "procedure", title: args.title as string, content: args.content as string,
        domain: (args.domain as string) ?? "general", tags: ["tutorial", (args.target_role as string) ?? "general"],
        sourceAgentId: commander?.agent.id ?? "system", scope: `domain:${(args.target_role as string) ?? "general"}`,
      });
      notebookWrite({
        namespace: `tutorial:${tenantId}`, key: (args.title as string).toLowerCase().replace(/\s+/g, "-"),
        value: args.content as string, contentType: "text/markdown",
      });
      return { saved: true, title: args.title };
    }

    case "save_knowledge": {
      const commander = getCommander();
      const entry = storeKnowledge({
        type: (args.type as any) ?? "domain_knowledge", title: args.title as string,
        content: args.content as string, domain: (args.domain as string) ?? "general",
        tags: (args.tags as string[]) ?? [], sourceAgentId: commander?.agent.id ?? "system",
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

    // ── Agent Management Tools ───────────────────────────────

    case "create_agent_template": {
      const { createTemplate: ct } = await import("../modules/agents/template.service.js");
      const tmpl = ct({
        name: args.name as string,
        role: args.role as any,
        systemPrompt: args.system_prompt as string,
        capabilities: (args.capabilities as string[]) ?? [],
        tools: (args.tools as string[]) ?? [],
        engine: (args.engine as any) ?? "fast-api",
        maxConcurrentTasks: (args.max_concurrent_tasks as number) ?? 1,
        autoSpawn: false,
      });
      return { id: tmpl.id, name: tmpl.name, role: tmpl.role };
    }

    case "list_agent_templates": {
      const { listTemplates: lt } = await import("../modules/agents/template.service.js");
      return lt({ role: args.role as string, status: (args.status as string) ?? "active" })
        .map(t => ({ id: t.id, name: t.name, role: t.role, engine: t.engine, autoSpawn: t.autoSpawn, status: t.status }));
    }

    case "spawn_agent": {
      const { agentPool: pool } = await import("../modules/agents/agent-pool.js");
      const spawned = pool.spawnAgent(
        args.template_id as string,
        args.template_name as string,
        args.parent_agent_id as string,
        (args.count as number) ?? 1,
      );
      return spawned.map(r => ({ id: r.agent.id, name: r.agent.name, role: r.agent.role }));
    }

    case "kill_agent": {
      const { agentPool: pool } = await import("../modules/agents/agent-pool.js");
      pool.killAgent(args.agent_id as string);
      return { killed: true, agent_id: args.agent_id };
    }

    case "list_agents": {
      const { listAgents: la } = await import("../modules/agents/agent.service.js");
      return la()
        .filter(a => {
          if (args.role && a.role !== args.role) return false;
          if (args.status && a.status !== args.status) return false;
          return a.status !== "deactivated";
        })
        .map(a => ({ id: a.id, name: a.name, role: a.role, status: a.status, templateId: a.templateId, performance: a.performanceScore, tasksCompleted: a.tasksCompleted }));
    }

    default: return { error: `Unknown tool: ${tool}` };
  }
}

// ── Commander Pipeline ──────────────────────────────────────

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
  onProgress?: (stage: string) => Promise<void>;
}): Promise<CommanderResponse> {
  const _files: CommanderResponse["files"] = [];
  const startTime = Date.now();

  console.error(`[Pipeline] ─── START ───────────────────────────`);
  console.error(`[Pipeline] User: ${input.userName} (${input.userRole})`);
  console.error(`[Pipeline] Message: "${input.userMessage}"`);

  // ── Get Commander agent ──────────────────────────────────
  const commander = getCommander();
  if (!commander) {
    return { text: "⚠️ Commander agent chưa khởi tạo. Restart hệ thống.", files: [] };
  }

  const commanderAgentId = commander.agent.id;
  heartbeat(commanderAgentId);

  // ── Step 1: Create Task (valid FK to Commander) ──────────
  let task;
  try {
    task = createTask({
      title: `Chat: ${input.userMessage.substring(0, 50)}`,
      description: input.userMessage,
      tags: ["chat", "telegram"],
      createdByAgentId: commanderAgentId,
    });
    assignTask(task.id, commanderAgentId, commanderAgentId);
    startTask(task.id, commanderAgentId);
    console.error(`[Pipeline] Task: ${task.id} → Commander (${commander.agent.name})`);
  } catch (taskErr: any) {
    console.error(`[Pipeline] Task creation skipped: ${taskErr.message}`);
    task = null;
  }

  // ── Step 2: Query Knowledge Base ─────────────────────────
  await input.onProgress?.("🔍 Đang tìm kiếm kiến thức...");
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
    console.error(`[Pipeline] Knowledge: ${knowledge.length} entries (top: ${knowledge[0].matchScore.toFixed(2)})`);
    knowledgeContext = `\n\nKNOWLEDGE BASE (đã học, ưu tiên dùng):\n${knowledge.map(k => `[${k.type}] ${k.title}: ${k.content.substring(0, 300)}`).join("\n\n")}`;
  } else {
    console.error(`[Pipeline] Knowledge: none`);
  }

  // ── Step 3: Build context ────────────────────────────────
  const uploadedFiles = listFiles(input.tenantId, 20);
  const fileContext = uploadedFiles.length > 0
    ? `\n\nFILES ĐÃ UPLOAD:\n${uploadedFiles.map((f: any) => `• ${f.fileName} (ID: ${f.id})`).join("\n")}\nKhi user hỏi về file/cẩm nang/tài liệu → gọi read_file_content(file_id) để đọc.`
    : "";

  const systemPrompt = buildCommanderPrompt(input.tenantName, input.userName, input.userRole, input.aiConfig) + knowledgeContext + fileContext;

  // ── Step 4: Commander THINKS ─────────────────────────────
  await input.onProgress?.("🤖 Commander đang suy nghĩ...");

  // Tool name → friendly label map
  const toolLabels: Record<string, string> = {
    list_files: "📂 Đang xem danh sách file...",
    read_file_content: "📖 Đang đọc nội dung file...",
    list_workflows: "⚙️ Đang xem quy trình...",
    create_workflow: "🔧 Đang tạo quy trình...",
    create_form: "📋 Đang tạo form...",
    search_knowledge: "🔍 Đang tìm kiến thức...",
    save_knowledge: "💾 Đang lưu kiến thức...",
    save_tutorial: "📝 Đang lưu tutorial...",
    get_dashboard: "📊 Đang lấy dashboard...",
    send_file: "📤 Đang gửi file...",
  };

  // Create a per-request runner with the right context + tool executor
  const runner = new AgentRunner({
    agent: commander.agent,
    engine: commander.engine,
    tools: [],
    systemPrompt,
    executeTool: async (tool, args) => {
      await input.onProgress?.(toolLabels[tool] ?? `🔄 Đang thực thi ${tool}...`);
      const toolResult = await executeTool(tool, args, input.tenantId);
      if (toolResult && typeof toolResult === "object" && (toolResult as any).__send_file__) {
        _files.push({ url: (toolResult as any).url, fileName: (toolResult as any).fileName, mimeType: (toolResult as any).mimeType });
      }
      return toolResult;
    },
    maxToolLoops: 5,
  });

  try {
    const result = await runner.think(input.userMessage, input.conversationHistory);

    await input.onProgress?.("✍️ Đang tổng hợp câu trả lời...");

    // ── Step 5: Complete task + update performance ──────────
    if (task) {
      try {
        completeTask(task.id, commanderAgentId, result.text.substring(0, 200));
      } catch {}
    }
    updatePerformance(commanderAgentId, true);

    // ── Step 6: Self-learning ──────────────────────────────
    if (result.toolCalls.length > 0) {
      const toolNames = result.toolCalls.map(t => t.tool).join(", ");
      try {
        storeKnowledge({
          type: "best_practice",
          title: `Q: ${input.userMessage.substring(0, 80)}`,
          content: `User: "${input.userMessage}"\nTools: ${toolNames}\nAnswer: ${result.text.substring(0, 500)}`,
          domain: "general",
          tags: [...keywords.slice(0, 5), ...result.toolCalls.map(t => t.tool)],
          sourceAgentId: commanderAgentId,
          sourceTaskId: task?.id,
          outcome: "success",
        });
        console.error(`[Pipeline] ✓ Knowledge saved (${toolNames})`);
      } catch (ke: any) {
        console.error(`[Pipeline] Knowledge save warn: ${ke.message}`);
      }
    }

    // ── Step 7: Audit ──────────────────────────────────────
    recordDecision({
      agentId: commanderAgentId,
      decisionType: "assign",
      taskId: task?.id,
      reasoning: `Chat: "${input.userMessage.substring(0, 60)}". Tools: ${result.toolCalls.map(t => t.tool).join(", ") || "none"}. Knowledge: ${knowledge.length}.`,
    });

    const elapsed = Date.now() - startTime;
    console.error(`[Pipeline] ─── END (${elapsed}ms, ${result.toolCalls.length} tools) ────────────`);

    return { text: result.text, files: _files };
  } catch (e: any) {
    // ── Error handling ──────────────────────────────────────
    if (task) {
      try { failTask(task.id, commanderAgentId, e.message); } catch {}
    }
    updatePerformance(commanderAgentId, false);

    try {
      storeKnowledge({
        type: "anti_pattern",
        title: `Failed: ${input.userMessage.substring(0, 80)}`,
        content: `Error: ${e.message}`,
        domain: "general",
        tags: keywords.slice(0, 5),
        sourceAgentId: commanderAgentId,
        outcome: "failure",
      });
    } catch {}

    console.error(`[Pipeline] ✗ Error (${Date.now() - startTime}ms): ${e.message}`);
    return { text: `⚠️ Lỗi: ${e.message}`, files: _files };
  }
}

// ── System Prompt ────────────────────────────────────────────

function buildCommanderPrompt(
  tenantName: string, userName: string, userRole: string,
  aiConfig: Record<string, unknown>
): string {
  const customInstructions = (aiConfig.system_prompt as string) ?? "";

  return `Bạn là Milo — trợ lý AI của ${tenantName}. Luôn xưng "Milo" khi giao tiếp.

USER: ${userName} | ROLE: ${userRole} | QUYỀN: ${userRole === "admin" || userRole === "manager" ? "ADMIN — tạo/sửa quy trình, tutorial, rules, quản lý user, quản lý agents" : "USER — sử dụng quy trình có sẵn, hỏi đáp"}

Bạn có tools sau. Khi cần, output JSON block \`\`\`tool_calls để gọi:

Tools — Business:
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

Tools — Agent Management (ADMIN only):
15. create_agent_template(name, role, system_prompt, capabilities[], tools[], engine?) — Tạo template agent mới
16. list_agent_templates(role?, status?) — Xem templates
17. spawn_agent(template_id?, template_name?, count?) — Tạo agent từ template
18. kill_agent(agent_id) — Tắt agent
19. list_agents(role?, status?) — Xem agents đang chạy

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
