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
import { storeKnowledge, retrieveKnowledge, mergeOrCreateRule, detectFeedback, applyFeedback } from "../modules/knowledge/knowledge.service.js";
import { getDashboard } from "../modules/monitoring/monitor.service.js";
import { startWorkflow } from "../modules/workflows/workflow-engine.service.js";
import { getFile, listFiles, readFileContent } from "../modules/storage/s3.service.js";
import { getQueueMetrics } from "./telegram.bot.js";
import { createTask, assignTask, startTask, completeTask, failTask } from "../modules/tasks/task.service.js";
import { recordDecision } from "../modules/decisions/decision.service.js";
import { updatePerformance, heartbeat } from "../modules/agents/agent.service.js";
import { getCommander } from "../modules/agents/agent-pool.js";
import { AgentRunner, detectEngine } from "../modules/agents/agent-runner.js";
import {
  workflowTemplates, formTemplates, businessRules,
  tenantUsers,
} from "../db/schema.js";
import { createCollection, listCollections, findCollection, insertRow, listRows, updateRow, deleteRow, searchAllRows } from "../modules/collections/collection.service.js";
import { startFormSession, updateFormField, getFormState, cancelFormSession } from "../modules/conversations/conversation.service.js";
import { checkPermission, createPermissionRequest, logAudit } from "../modules/permissions/permission.service.js";
import { newId } from "../utils/id.js";
import { nowMs } from "../utils/clock.js";

// Per-request context for form + permission tools
let _currentSessionId: string | null = null;
let _currentUser: { id: string; name: string; role: string } | null = null;
// Track last tools called per session — for feedback detection
const _lastToolsCalledBySession = new Map<string, string[]>();

// ── Tool Registry ─────────────────────────────────────────────

export async function executeTool(tool: string, args: Record<string, unknown>, tenantId: string): Promise<unknown> {
  const db = getDb();
  const now = nowMs();

  switch (tool) {
    case "list_workflows": {
      return await db.select({ id: workflowTemplates.id, name: workflowTemplates.name, description: workflowTemplates.description, domain: workflowTemplates.domain })
        .from(workflowTemplates)
        .where(and(eq(workflowTemplates.tenantId, tenantId), eq(workflowTemplates.status, "active")));
    }

    case "create_workflow": {
      const id = newId();
      const stages = ((args.stages as any[]) ?? []).map((s: any, i: number) => ({
        id: s.id ?? `step_${i + 1}`, name: s.name, type: s.type ?? "form",
        next_stage_id: s.next_stage_id ?? (i < (args.stages as any[]).length - 1 ? (args.stages as any[])[i + 1]?.id ?? `step_${i + 2}` : undefined),
      }));
      await db.insert(workflowTemplates).values({
        id, tenantId, name: args.name as string, description: (args.description as string) ?? null,
        domain: (args.domain as string) ?? null, version: 1, stages: JSON.stringify(stages),
        status: "active", createdAt: now, updatedAt: now,
      });
      return { id, name: args.name, stageCount: stages.length };
    }

    case "create_form": {
      const id = newId();
      await db.insert(formTemplates).values({
        id, tenantId, name: args.name as string,
        schema: JSON.stringify({ fields: args.fields ?? [] }),
        version: 1, status: "active", createdAt: now, updatedAt: now,
      });
      return { id, name: args.name };
    }

    case "create_rule": {
      const id = newId();
      await db.insert(businessRules).values({
        id, tenantId, name: args.name as string, description: (args.description as string) ?? null,
        domain: (args.domain as string) ?? null, ruleType: (args.rule_type as any) ?? "validation",
        conditions: JSON.stringify(args.conditions ?? {}), actions: JSON.stringify(args.actions ?? []),
        priority: (args.priority as number) ?? 0, status: "active", createdAt: now, updatedAt: now,
      });
      return { id, name: args.name };
    }

    case "save_tutorial": {
      const commander = getCommander();
      await storeKnowledge({
        type: "procedure", title: args.title as string, content: args.content as string,
        domain: (args.domain as string) ?? "general", tags: ["tutorial", (args.target_role as string) ?? "general"],
        sourceAgentId: commander?.agent.id ?? "system", scope: `domain:${(args.target_role as string) ?? "general"}`,
      });
      await notebookWrite({
        namespace: `tutorial:${tenantId}`, key: (args.title as string).toLowerCase().replace(/\s+/g, "-"),
        value: args.content as string, contentType: "text/markdown",
      });
      return { saved: true, title: args.title };
    }

    case "save_knowledge": {
      const commander = getCommander();
      const entry = await storeKnowledge({
        type: (args.type as any) ?? "domain_knowledge", title: args.title as string,
        content: args.content as string, domain: (args.domain as string) ?? "general",
        tags: (args.tags as string[]) ?? [], sourceAgentId: commander?.agent.id ?? "system",
      });
      return { id: entry.id, title: entry.title };
    }

    case "list_tutorials": {
      return (await retrieveKnowledge({ tags: ["tutorial"], capabilities: [], domain: (args.domain as string) ?? "general", limit: 10 }))
        .map(r => ({ title: r.title, domain: r.domain, content: r.content.substring(0, 200) + "..." }));
    }

    case "start_workflow_instance": {
      const instance = await startWorkflow({
        templateId: args.template_id as string, tenantId,
        initiatedBy: (args.initiated_by as string) ?? "telegram", channel: "telegram",
      });
      return { instanceId: instance.id, status: instance.status };
    }

    case "get_dashboard": {
      const dash = await getDashboard();
      const queueMetrics = getQueueMetrics?.() ?? null;
      return { ...dash, queue: queueMetrics };
    }

    case "search_knowledge": {
      return (await retrieveKnowledge({
        tags: (args.tags as string[]) ?? [], capabilities: [],
        domain: (args.domain as string) ?? "general", limit: 5,
      })).map(r => ({ title: r.title, content: r.content.substring(0, 200), score: r.matchScore }));
    }

    case "read_file_content": {
      let fileId = args.file_id as string;
      if (fileId && !fileId.startsWith("01")) {
        const allFiles = await listFiles(tenantId, 50);
        const match = allFiles.find((f: any) => f.fileName.toLowerCase().includes(fileId.toLowerCase()));
        if (match) fileId = match.id;
      }
      const result = await readFileContent(fileId);
      if (!result) return { error: "File not found or cannot read" };
      return { fileName: result.fileName, content: result.content, truncated: result.truncated };
    }

    case "send_file": {
      const file = await getFile(args.file_id as string);
      if (!file) return { error: "File not found" };
      return { __send_file__: true, url: file.s3Url, fileName: file.fileName, mimeType: file.mimeType };
    }

    case "analyze_image": {
      // Download image from S3 → save temp → call Claude CLI with --image
      let fileId = args.file_id as string;
      if (fileId && !fileId.startsWith("01")) {
        const allFiles = await listFiles(tenantId, 50);
        const match = allFiles.find((f: any) => f.fileName.toLowerCase().includes(fileId.toLowerCase()));
        if (match) fileId = match.id;
      }
      const file = await getFile(fileId);
      if (!file) return { error: "File not found" };
      if (!file.mimeType?.startsWith("image/")) return { error: "Not an image file" };

      try {
        const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
        const { getConfig: gc } = await import("../config.js");
        const cfg = gc();
        const s3 = new S3Client({
          region: cfg.S3_REGION!, endpoint: cfg.S3_ENDPOINT!,
          credentials: { accessKeyId: cfg.S3_ACCESS_KEY!, secretAccessKey: cfg.S3_SECRET_KEY! },
          forcePathStyle: true,
        });
        const obj = await s3.send(new GetObjectCommand({ Bucket: cfg.S3_BUCKET!, Key: file.s3Key }));
        const chunks: Buffer[] = [];
        for await (const chunk of obj.Body as any) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);

        const { writeFileSync, unlinkSync } = await import("fs");
        const ext = file.fileName.split(".").pop() ?? "jpg";
        const tmpPath = `/tmp/img_${Date.now()}.${ext}`;
        writeFileSync(tmpPath, buffer);

        // Call Claude CLI with Read tool — vision through Max subscription
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);

        const prompt = (args.prompt as string) ?? "Mô tả chi tiết nội dung ảnh này. Nếu là sản phẩm thì mô tả màu sắc, kiểu dáng, chất liệu. Nếu là tài liệu/invoice thì trích xuất thông tin quan trọng.";

        const { stdout } = await execFileAsync(
          "claude",
          ["--print", "--output-format", "text", "--max-turns", "3",
           "--allowedTools", "Read",
           "-p", `Read the file ${tmpPath} and then: ${prompt}`],
          { encoding: "utf-8", timeout: 60_000, cwd: "/tmp", maxBuffer: 10 * 1024 * 1024 },
        );

        try { unlinkSync(tmpPath); } catch {}
        return { fileName: file.fileName, analysis: (stdout ?? "").trim() };
      } catch (err: any) {
        return { error: `Vision failed: ${err.message}` };
      }
    }

    case "list_files": return await listFiles(tenantId, (args.limit as number) ?? 20);
    case "get_file": return await getFile(args.file_id as string);

    case "set_user_role": {
      const channel = (args.channel as string) ?? "telegram";
      let channelUserId = (args.channel_user_id as string) ?? "";

      // If LLM passed username instead of numeric ID, find the real ID from DB
      if (channelUserId && !/^\d+$/.test(channelUserId)) {
        const allUsers = await db.select({ channelUserId: tenantUsers.channelUserId, displayName: tenantUsers.displayName })
          .from(tenantUsers).where(eq(tenantUsers.tenantId, tenantId));
        const match = allUsers.find(u =>
          u.displayName?.toLowerCase().includes(channelUserId.toLowerCase()) ||
          channelUserId.toLowerCase().includes(u.displayName?.toLowerCase() ?? "___")
        );
        if (match) {
          channelUserId = match.channelUserId;
        } else {
          return { error: `User "${args.channel_user_id}" không tìm thấy. Dùng list_users để xem danh sách.` };
        }
      }

      const existing = (await db.select({ id: tenantUsers.id }).from(tenantUsers)
        .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.channel, channel), eq(tenantUsers.channelUserId, channelUserId))).limit(1))[0];
      if (existing) {
        await db.update(tenantUsers).set({ role: args.role as any, displayName: (args.display_name as string) ?? undefined, updatedAt: now })
          .where(eq(tenantUsers.id, existing.id));
      } else {
        return { error: `User ID "${channelUserId}" không tồn tại trong hệ thống.` };
      }
      return { success: true, channel_user_id: channelUserId, role: args.role };
    }

    case "list_users": {
      return await db.select({
        channelUserId: tenantUsers.channelUserId, channel: tenantUsers.channel,
        displayName: tenantUsers.displayName, role: tenantUsers.role, isActive: tenantUsers.isActive,
      }).from(tenantUsers).where(eq(tenantUsers.tenantId, tenantId));
    }

    // ── AI Config Tools (admin edits bot behavior via chat) ──

    case "update_ai_config": {
      const { tenants } = await import("../db/schema.js");
      const tenant = (await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1))[0];
      if (!tenant) return { error: "Tenant not found" };
      const current = (tenant.aiConfig ?? {}) as Record<string, unknown>;

      // Merge updates into current config
      const updates = args as Record<string, unknown>;
      for (const [key, value] of Object.entries(updates)) {
        if (key === "rules" && Array.isArray(value)) {
          // Append rules instead of replace
          const existing = (current.rules as string[]) ?? [];
          current.rules = [...existing, ...value];
        } else if (key === "remove_rule" && typeof value === "number") {
          const existing = (current.rules as string[]) ?? [];
          existing.splice(value, 1);
          current.rules = existing;
        } else {
          current[key] = value;
        }
      }

      await db.update(tenants).set({ aiConfig: current, updatedAt: nowMs() }).where(eq(tenants.id, tenantId));
      return { success: true, updated_keys: Object.keys(updates), config: current };
    }

    case "get_ai_config": {
      const { tenants: t } = await import("../db/schema.js");
      const tn = (await db.select().from(t).where(eq(t.id, tenantId)).limit(1))[0];
      return tn?.aiConfig ?? {};
    }

    // ── Agent Management Tools ───────────────────────────────

    case "create_agent_template": {
      const { createTemplate: ct } = await import("../modules/agents/template.service.js");
      const tmpl = await ct({
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
      return (await lt({ role: args.role as string, status: (args.status as string) ?? "active" }))
        .map(t => ({ id: t.id, name: t.name, role: t.role, engine: t.engine, autoSpawn: t.autoSpawn, status: t.status }));
    }

    case "spawn_agent": {
      const { agentPool: pool } = await import("../modules/agents/agent-pool.js");
      const spawned = await pool.spawnAgent(
        args.template_id as string,
        args.template_name as string,
        args.parent_agent_id as string,
        (args.count as number) ?? 1,
      );
      return spawned.map(r => ({ id: r.agent.id, name: r.agent.name, role: r.agent.role }));
    }

    case "kill_agent": {
      const { agentPool: pool } = await import("../modules/agents/agent-pool.js");
      await pool.killAgent(args.agent_id as string);
      return { killed: true, agent_id: args.agent_id };
    }

    case "list_agents": {
      const { listAgents: la } = await import("../modules/agents/agent.service.js");
      return (await la())
        .filter(a => {
          if (args.role && a.role !== args.role) return false;
          if (args.status && a.status !== args.status) return false;
          return a.status !== "deactivated";
        })
        .map(a => ({ id: a.id, name: a.name, role: a.role, status: a.status, templateId: a.templateId, performance: a.performanceScore, tasksCompleted: a.tasksCompleted }));
    }

    // ── Dynamic Collections (admin-defined tables) ─────────

    case "create_collection": {
      return await createCollection({
        tenantId,
        name: args.name as string,
        description: (args.description as string) ?? undefined,
        fields: (args.fields as any[]) ?? [],
        createdBy: (args.created_by as string) ?? undefined,
      });
    }

    case "list_collections": {
      return await listCollections(tenantId);
    }

    case "add_row": {
      // Find collection by name or ID
      let collectionId = args.collection_id as string;
      if (!collectionId || !collectionId.startsWith("01")) {
        const col = await findCollection(tenantId, (args.collection as string) ?? (args.collection_id as string) ?? "");
        if (!col) return { error: `Collection "${args.collection ?? args.collection_id}" không tồn tại` };
        collectionId = col.id;
      }
      return await insertRow({
        collectionId,
        data: (args.data as Record<string, unknown>) ?? {},
        createdBy: (args.created_by as string) ?? undefined,
      });
    }

    case "list_rows": {
      let collectionId = args.collection_id as string;
      if (!collectionId || !collectionId.startsWith("01")) {
        const col = await findCollection(tenantId, (args.collection as string) ?? (args.collection_id as string) ?? "");
        if (!col) return { error: `Collection "${args.collection ?? args.collection_id}" không tồn tại` };
        collectionId = col.id;
      }
      const result = await listRows(
        collectionId,
        (args.limit as number) ?? 20,
        (args.offset as number) ?? 0,
        (args.keyword as string) ?? undefined,
      );

      // Auto-resolve file names → S3 URLs
      const allFiles = await listFiles(tenantId, 100);
      for (const row of result.rows) {
        const data = row.data as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === "string" && /\.(jpg|jpeg|png|gif|webp|pdf|docx)$/i.test(value)) {
            const match = allFiles.find((f: any) => f.fileName === value);
            if (match) data[key] = (match as any).s3Url;
          }
        }
      }

      // Pagination info for LLM
      if (result.hasMore) {
        return { rows: result.rows, total: result.total, showing: result.rows.length, hasMore: true, hint: `Còn ${result.total - result.rows.length} rows. Dùng offset=${result.rows.length} để xem tiếp.` };
      }
      return { rows: result.rows, total: result.total };
    }

    case "update_row": {
      return await updateRow(args.row_id as string, (args.data as Record<string, unknown>) ?? {});
    }

    case "delete_row": {
      const deleted = await deleteRow(args.row_id as string);
      return { deleted, row_id: args.row_id };
    }

    case "search_all": {
      const rows = await searchAllRows(tenantId, (args.keyword as string) ?? undefined, (args.limit as number) ?? 20);
      // Auto-resolve file names → S3 URLs
      const allFiles = await listFiles(tenantId, 100);
      for (const row of rows) {
        const data = row.data as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === "string" && /\.(jpg|jpeg|png|gif|webp|pdf|docx)$/i.test(value)) {
            const match = allFiles.find((f: any) => f.fileName === value);
            if (match) data[key] = (match as any).s3Url;
          }
        }
      }
      return rows;
    }

    // ── DB Query Meta-tool (permission-checked) ───────────────

    case "db_query": {
      const table = args.table as string;
      const action = args.action as string; // list, get, create, update, delete
      const filter = (args.filter as Record<string, unknown>) ?? {};
      const data = (args.data as Record<string, unknown>) ?? {};

      if (!_currentUser) return { error: "No user context" };

      // Whitelist tables
      const ALLOWED_TABLES = [
        "form_templates", "workflow_templates", "business_rules",
        "collections", "collection_rows", "knowledge_entries",
      ];
      if (!ALLOWED_TABLES.includes(table)) {
        return { error: `Bảng "${table}" không được phép truy cập qua db_query` };
      }

      // Permission check
      const perm = await checkPermission(tenantId, _currentUser.id, _currentUser.role, table, action);
      if (!perm.allowed) {
        if (perm.needsApproval) {
          return {
            denied: true,
            reason: perm.reason,
            canRequestAccess: true,
            approver: perm.needsApproval.approverName,
            hint: `Dùng tool request_permission(resource="${table}", access="CRUD") để xin quyền từ ${perm.needsApproval.approverName}`,
          };
        }
        return { denied: true, reason: perm.reason };
      }

      // Execute query
      const tableMap: Record<string, any> = {
        form_templates: (await import("../db/schema.js")).formTemplates,
        workflow_templates: (await import("../db/schema.js")).workflowTemplates,
        business_rules: (await import("../db/schema.js")).businessRules,
        collections: (await import("../db/schema.js")).collections,
        collection_rows: (await import("../db/schema.js")).collectionRows,
        knowledge_entries: (await import("../db/schema.js")).knowledgeEntries,
      };
      const dbTable = tableMap[table];
      if (!dbTable) return { error: `Table ${table} not mapped` };

      let result: unknown;

      if (action === "list" || action === "get") {
        let q = db.select().from(dbTable);
        // Apply tenant filter if table has tenantId
        if ("tenantId" in dbTable) {
          q = q.where(eq(dbTable.tenantId, tenantId)) as any;
        }
        if (action === "get" && filter.id) {
          q = q.where(eq(dbTable.id, filter.id as string)) as any;
        }
        result = await (q as any).limit(action === "get" ? 1 : 50);

      } else if (action === "create") {
        const id = newId();
        const values: any = {
          id, ...data,
          createdAt: now, updatedAt: now,
          createdByUserId: _currentUser.id,
          createdByName: _currentUser.name,
        };
        if ("tenantId" in dbTable) values.tenantId = tenantId;
        await db.insert(dbTable).values(values);
        result = { id, created: true };

      } else if (action === "update") {
        if (!filter.id) return { error: "filter.id required for update" };
        await db.update(dbTable).set({
          ...data,
          updatedAt: now,
          updatedByUserId: _currentUser.id,
          updatedByName: _currentUser.name,
        }).where(eq(dbTable.id, filter.id as string));
        result = { updated: true, id: filter.id };

      } else if (action === "delete") {
        if (!filter.id) return { error: "filter.id required for delete" };
        await db.delete(dbTable).where(eq(dbTable.id, filter.id as string));
        result = { deleted: true, id: filter.id };
      }

      // Audit log
      await logAudit({
        tenantId, userId: _currentUser.id, userName: _currentUser.name,
        userRole: _currentUser.role, action, resourceTable: table,
        resourceId: (filter.id as string) ?? undefined,
        afterData: action === "create" || action === "update" ? data : undefined,
      });

      return result;
    }

    case "request_permission": {
      if (!_currentUser) return { error: "No user context" };
      const perm = await checkPermission(tenantId, _currentUser.id, _currentUser.role, args.resource as string, "create");
      if (perm.allowed) return { already_granted: true };
      if (!perm.needsApproval) return { error: "Không tìm được người duyệt" };

      const reqId = await createPermissionRequest({
        tenantId,
        requesterId: _currentUser.id,
        requesterName: _currentUser.name,
        approverId: perm.needsApproval.approverId,
        approverName: perm.needsApproval.approverName,
        resource: args.resource as string,
        requestedAccess: (args.access as string) ?? "CRU",
        reason: args.reason as string,
      });

      return {
        requestSent: true,
        requestId: reqId,
        approver: perm.needsApproval.approverName,
        resource: args.resource,
        access: (args.access as string) ?? "CRU",
        __notify_user__: {
          userId: perm.needsApproval.approverId,
          message: `🔔 <b>${_currentUser.name}</b> xin quyền <b>${(args.access as string) ?? "CRU"}</b> trên <b>${args.resource}</b>\n\nLý do: ${(args.reason as string) ?? "Không nêu"}\n\n<code>/grant ${_currentUser.id} ${args.resource} ${(args.access as string) ?? "CRU"}</code>\n<code>/deny ${reqId}</code>`,
        },
      };
    }

    // ── Form State Tools ──────────────────────────────────────

    case "start_form": {
      if (!_currentSessionId) return { error: "No session" };
      const { formTemplates: ft } = await import("../db/schema.js");
      // Find form template by name or ID
      let formId = args.form_id as string;
      let formName = args.form_name as string;
      if (!formId && formName) {
        const forms = await db.select().from(ft).where(eq(ft.tenantId, tenantId));
        const match = forms.find(f => f.name.toLowerCase().includes(formName.toLowerCase()));
        if (match) { formId = match.id; formName = match.name; }
      }
      if (!formId) return { error: `Form "${args.form_name}" không tìm thấy` };
      const form = (await db.select().from(ft).where(eq(ft.id, formId)).limit(1))[0];
      if (!form) return { error: "Form not found" };
      const schema = typeof form.schema === "string" ? JSON.parse(form.schema) : form.schema;
      const fields = (schema.fields ?? []).map((f: any) => ({ label: f.label, required: f.required }));
      const state = await startFormSession(_currentSessionId, form.name, formId, fields);
      return { started: true, formName: form.name, totalSteps: state.totalSteps, firstField: state.pendingFields[0] };
    }

    case "update_form_field": {
      if (!_currentSessionId) return { error: "No session" };
      const state = await updateFormField(_currentSessionId, args.field_name as string, args.value);
      const next = state.pendingFields[0] ?? null;
      return {
        saved: true, field: args.field_name, value: args.value,
        step: state.currentStep, total: state.totalSteps,
        nextField: next, completed: state.status === "completed",
        data: state.data,
      };
    }

    case "get_form_state": {
      if (!_currentSessionId) return { error: "No session" };
      const state = await getFormState(_currentSessionId);
      if (!state) return { noForm: true };
      return state;
    }

    case "cancel_form": {
      if (!_currentSessionId) return { error: "No session" };
      await cancelFormSession(_currentSessionId);
      return { cancelled: true };
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
  sessionId?: string;
}): Promise<CommanderResponse> {
  // Set per-request context for form + permission tools
  _currentSessionId = input.sessionId ?? null;
  _currentUser = { id: input.userId, name: input.userName, role: input.userRole };
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
  await heartbeat(commanderAgentId);

  // ── Step 1: Create Task (valid FK to Commander) ──────────
  let task;
  try {
    task = await createTask({
      title: `Chat: ${input.userMessage.substring(0, 50)}`,
      description: input.userMessage,
      tags: ["chat", "telegram"],
      createdByAgentId: commanderAgentId,
    });
    await assignTask(task.id, commanderAgentId, commanderAgentId);
    await startTask(task.id, commanderAgentId);
    console.error(`[Pipeline] Task: ${task.id} → Commander (${commander.agent.name})`);
  } catch (taskErr: any) {
    console.error(`[Pipeline] Task creation skipped: ${taskErr.message}`);
    task = null;
  }

  // ── Step 0: Feedback Detection (ngầm, user không biết) ───
  const lastBotMsg = input.conversationHistory
    .filter(m => m.role === "assistant")
    .at(-1)?.content ?? "";
  const lastToolsCalled = _lastToolsCalledBySession.get(input.sessionId ?? "") ?? [];

  if (lastBotMsg && lastToolsCalled.length > 0) {
    try {
      const { getConfig: gc } = await import("../config.js");
      const cfg = gc();
      const feedback = await detectFeedback({
        userMessage: input.userMessage,
        prevBotResponse: lastBotMsg,
        workerApiBase: cfg.WORKER_API_BASE!,
        workerApiKey: cfg.WORKER_API_KEY!,
        workerModel: cfg.WORKER_MODEL!,
      });

      if (feedback !== "neutral") {
        await applyFeedback({
          feedback,
          userMessage: input.userMessage,
          lastToolsCalled,
          lastBotResponse: lastBotMsg,
        });
      }
    } catch (fbErr: any) {
      console.error(`[Pipeline] Feedback detect skipped: ${fbErr.message}`);
    }
  }

  // ── Step 2: Query Knowledge Base ─────────────────────────
  await input.onProgress?.("🔍 Đang tìm kiếm kiến thức...");
  const keywords = input.userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const knowledge = await retrieveKnowledge({
    tags: keywords,
    capabilities: [],
    domain: "general",
    scope: ["global", `domain:sales`, `domain:general`],
    limit: 3,
  });

  let knowledgeContext = "";
  if (knowledge.length > 0 && knowledge[0].matchScore > 0.3) {
    console.error(`[Pipeline] Knowledge: ${knowledge.length} entries (top: ${knowledge[0].matchScore.toFixed(2)})`);
    knowledgeContext = `\n\nKNOWLEDGE BASE (đã học, ưu tiên dùng):\n${knowledge.map(k => {
      const rejected = (k.content ?? "").includes("⚠️ REJECTED");
      return `[${k.type}${rejected ? " ⚠️ BỊ REJECT" : ""}] ${k.title}: ${k.content.substring(0, 300)}`;
    }).join("\n\n")}`;
  } else {
    console.error(`[Pipeline] Knowledge: none`);
  }

  // ── Step 3: Build context ────────────────────────────────
  const uploadedFiles = await listFiles(input.tenantId, 20);
  const fileContext = uploadedFiles.length > 0
    ? `\n\nFILES ĐÃ UPLOAD:\n${uploadedFiles.map((f: any) => `• ${f.fileName} (ID: ${f.id})`).join("\n")}\nKhi user hỏi về file/cẩm nang/tài liệu → gọi read_file_content(file_id) để đọc.`
    : "";

  // ── Step 3b: Form state context ───────────────────────────
  let formContext = "";
  if (input.sessionId) {
    const formState = await getFormState(input.sessionId);
    if (formState && formState.status === "in_progress") {
      const filled = Object.entries(formState.data)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v], i) => `  ${i + 1}. ${k}: ${v} ✅`)
        .join("\n");
      const pending = formState.pendingFields
        .map((f, i) => `  ${Object.keys(formState.data).length + i + 1}. ${f}${i === 0 ? " ← ĐANG CHỜ" : ""}`)
        .join("\n");
      formContext = `\n\nFORM ĐANG NHẬP: "${formState.formName}" (bước ${formState.currentStep}/${formState.totalSteps})
ĐÃ ĐIỀN:\n${filled || "  (chưa có)"}
ĐANG CHỜ:\n${pending || "  (hoàn thành)"}
→ Khi user trả lời → gọi update_form_field(field_name, value) để lưu. KHÔNG hỏi lại field đã điền.`;
    }
  }

  const systemPrompt = buildCommanderPrompt(input.tenantName, input.userName, input.userRole, input.aiConfig) + knowledgeContext + fileContext + formContext;

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

  // Hybrid routing — simple questions → fast-api (2s), complex → CLI (15s)
  const topScore = knowledge.length > 0 ? knowledge[0].matchScore : 0;
  const effectiveEngine = detectEngine(input.userMessage, topScore, true);
  console.error(`[Pipeline] Engine: ${effectiveEngine} (score: ${topScore.toFixed(2)})`);

  const runner = new AgentRunner({
    agent: commander.agent,
    engine: effectiveEngine,
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
        await completeTask(task.id, commanderAgentId, result.text.substring(0, 200));
      } catch {}
    }
    await updatePerformance(commanderAgentId, true);

    // ── Step 6: Self-learning (intent-based, auto-merge) ────
    if (result.toolCalls.length > 0) {
      try {
        const tools = result.toolCalls.map(t => t.tool);
        const { action, ruleId } = await mergeOrCreateRule({
          tools,
          keywords,
          sourceAgentId: commanderAgentId,
        });
        console.error(`[Pipeline] ✓ Knowledge ${action}: ${[...new Set(tools)].join(",")} (${ruleId.substring(0, 8)})`);
      } catch (ke: any) {
        console.error(`[Pipeline] Knowledge save warn: ${ke.message}`);
      }
    }

    // ── Step 6b: Save context for feedback detection next turn
    _lastToolsCalledBySession.set(input.sessionId ?? "", result.toolCalls.map(t => t.tool));

    // ── Step 7: Audit ──────────────────────────────────────
    await recordDecision({
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
      try { await failTask(task.id, commanderAgentId, e.message); } catch {}
    }
    await updatePerformance(commanderAgentId, false);

    // Save anti-pattern rule (what NOT to do)
    try {
      const intentKeywords = keywords.slice(0, 3).join(" ");
      await storeKnowledge({
        type: "anti_pattern",
        title: `Anti-pattern: ${intentKeywords}`,
        content: `Khi user hỏi "${intentKeywords}" → TRÁNH: ${e.message.substring(0, 100)}. Cần kiểm tra lại cách gọi tool.`,
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

// ── System Prompt (from DB, not hardcoded) ───────────────────

function buildCommanderPrompt(
  tenantName: string, userName: string, userRole: string,
  aiConfig: Record<string, unknown>
): string {
  const cfg = aiConfig as any;
  const botName = cfg.bot_name ?? "Bot";
  const botIntro = cfg.bot_intro ?? "trợ lý AI";
  const rolePerms = cfg.role_permissions ?? {};
  const userPermissions = rolePerms[userRole] ?? `${userRole.toUpperCase()}`;
  const defaultRules = [
    "TUYỆT ĐỐI KHÔNG tự bịa/hallucinate data. Chỉ trả lời dựa trên data thật từ tools hoặc knowledge base",
    "Khi user hỏi về file/cẩm nang/tài liệu → PHẢI gọi list_files rồi read_file_content trước khi trả lời",
    "Khi user muốn lưu/tạo đơn hàng/dữ liệu → PHẢI dùng create_collection (tạo bảng) + add_row (thêm dòng) để LƯU VÀO DB THẬT",
    "Khi user hỏi xem đơn hàng/dữ liệu → PHẢI gọi list_rows để query DB, KHÔNG tự bịa mã đơn hay số liệu",
    "KHÔNG tự tạo URL. Khi cần gửi file/ảnh → gọi tool send_file(file_id)",
    "Khi user tìm kiếm data mà KHÔNG nói rõ khoảng thời gian/bộ lọc → HỎI LẠI: 'Bạn muốn xem tất cả hay lọc theo thời gian/trạng thái?' trước khi gọi search_all",
    "list_rows/search_all có hỗ trợ keyword filter — dùng search_all(keyword='từ khoá') để lọc, KHÔNG load hết rồi lọc bằng text",
    "Khi kết quả > 20 rows → trả summary (tổng, phân loại) + hỏi user muốn xem chi tiết phần nào",
    "Ngắn gọn, thực tế, đúng trọng tâm câu hỏi",
  ];
  const rules = [...defaultRules, ...((cfg.rules as string[]) ?? [])];
  const customInstructions = (cfg.custom_instructions as string) ?? "";

  // Build tool instructions from DB config
  const tools = cfg.tools ?? {};
  let toolInstructions = "Bạn có tools sau. Khi cần, output JSON block ```tool_calls để gọi:\n";

  let idx = 1;
  for (const [category, toolList] of Object.entries(tools)) {
    const label = category === "business" ? "Business" : category === "agent_management" ? "Agent Management (ADMIN only)" : category;
    toolInstructions += `\nTools — ${label}:\n`;
    for (const t of toolList as any[]) {
      toolInstructions += `${idx}. ${t.name}(${t.args ?? ""}) — ${t.desc}\n`;
      idx++;
    }
  }

  toolInstructions += `\nCách gọi tool:\n\`\`\`tool_calls\n[{"tool":"tên_tool","args":{"key":"value"}}]\n\`\`\``;

  // Build rules
  const rulesText = rules.map((r: string) => `• ${r}`).join("\n");

  // Use template from DB, or fallback
  const template = (cfg.prompt_template as string) ?? `Bạn là {{bot_name}} — {{bot_intro}} của {{tenant_name}}.

USER: {{user_name}} | ROLE: {{user_role}}
QUYỀN: {{user_permissions}}

{{tool_instructions}}

QUY TẮC:
{{rules}}

{{custom_instructions}}`;

  return template
    .replace(/\{\{bot_name\}\}/g, botName)
    .replace(/\{\{bot_intro\}\}/g, botIntro)
    .replace(/\{\{tenant_name\}\}/g, tenantName)
    .replace(/\{\{user_name\}\}/g, userName)
    .replace(/\{\{user_role\}\}/g, userRole)
    .replace(/\{\{user_permissions\}\}/g, userPermissions)
    .replace(/\{\{tool_instructions\}\}/g, toolInstructions)
    .replace(/\{\{rules\}\}/g, rulesText)
    .replace(/\{\{custom_instructions\}\}/g, customInstructions)
    .trim();
}
