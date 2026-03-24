/**
 * Tool Registry — Map-based dynamic registry for all agent tools.
 */

import { getDb } from "../db/connection.js";
import { eq, and } from "drizzle-orm";
import { notebookWrite } from "../modules/notebooks/notebook.service.js";
import { storeKnowledge, retrieveKnowledge } from "../modules/knowledge/knowledge.service.js";
import { getDashboard } from "../modules/monitoring/monitor.service.js";
import { startWorkflow } from "../modules/workflows/workflow-engine.service.js";
import { getFile, listFiles, readFileContent } from "../modules/storage/s3.service.js";
import { getQueueMetrics } from "./telegram.bot.js";
import { getCommander } from "../modules/agents/agent-pool.js";
import {
  workflowTemplates, formTemplates, businessRules,
  tenantUsers,
} from "../db/schema.js";
import { createCollection, listCollections, findCollection, insertRow, listRows, updateRow, deleteRow, searchAllRows } from "../modules/collections/collection.service.js";
import { startFormSession, updateFormField, getFormState, cancelFormSession } from "../modules/conversations/conversation.service.js";
import { checkPermission, createPermissionRequest, logAudit } from "../modules/permissions/permission.service.js";
import { invalidateCache } from "../modules/cache/resource-cache.js";
import { newId } from "../utils/id.js";
import { nowMs } from "../utils/clock.js";

export interface ToolContext {
  sessionId: string | null;
  currentUser: { id: string; name: string; role: string } | null;
}

type ToolHandler = (args: Record<string, unknown>, tenantId: string, ctx: ToolContext) => Promise<unknown>;

const registry = new Map<string, ToolHandler>();

function registerTool(name: string, handler: ToolHandler) {
  registry.set(name, handler);
}

export function getRegisteredTools(): string[] {
  return Array.from(registry.keys());
}

export async function executeTool(
  tool: string,
  args: Record<string, unknown>,
  tenantId: string,
  toolCtx?: ToolContext,
): Promise<unknown> {
  const handler = registry.get(tool);
  if (!handler) return { error: `Unknown tool: ${tool}` };
  return handler(args, tenantId, toolCtx ?? { sessionId: null, currentUser: null });
}

// ── Workflow & Form Template Tools ─────────────────────────

registerTool("list_workflows", async (_args, tenantId) => {
  const db = getDb();
  return await db.select({ id: workflowTemplates.id, name: workflowTemplates.name, description: workflowTemplates.description, domain: workflowTemplates.domain })
    .from(workflowTemplates)
    .where(and(eq(workflowTemplates.tenantId, tenantId), eq(workflowTemplates.status, "active")));
});

registerTool("create_workflow", async (args, tenantId) => {
  const db = getDb();
  const now = nowMs();
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
});

registerTool("create_form", async (args, tenantId) => {
  const db = getDb();
  const now = nowMs();
  const id = newId();
  await db.insert(formTemplates).values({
    id, tenantId, name: args.name as string,
    schema: JSON.stringify({ fields: args.fields ?? [] }),
    version: 1, status: "active", createdAt: now, updatedAt: now,
  });
  return { id, name: args.name };
});

registerTool("create_rule", async (args, tenantId) => {
  const db = getDb();
  const now = nowMs();
  const id = newId();
  await db.insert(businessRules).values({
    id, tenantId, name: args.name as string, description: (args.description as string) ?? null,
    domain: (args.domain as string) ?? null, ruleType: (args.rule_type as any) ?? "validation",
    conditions: JSON.stringify(args.conditions ?? {}), actions: JSON.stringify(args.actions ?? []),
    priority: (args.priority as number) ?? 0, status: "active", createdAt: now, updatedAt: now,
  });
  return { id, name: args.name };
});

registerTool("start_workflow_instance", async (args, tenantId) => {
  const instance = await startWorkflow({
    templateId: args.template_id as string, tenantId,
    initiatedBy: (args.initiated_by as string) ?? "telegram", channel: "telegram",
  });
  return { instanceId: instance.id, status: instance.status };
});

// ── Knowledge Tools ────────────────────────────────────────

registerTool("save_tutorial", async (args, tenantId) => {
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
});

registerTool("save_knowledge", async (args) => {
  const commander = getCommander();
  const entry = await storeKnowledge({
    type: (args.type as any) ?? "domain_knowledge", title: args.title as string,
    content: args.content as string, domain: (args.domain as string) ?? "general",
    tags: (args.tags as string[]) ?? [], sourceAgentId: commander?.agent.id ?? "system",
  });
  return { id: entry.id, title: entry.title };
});

registerTool("list_tutorials", async (args) => {
  return (await retrieveKnowledge({ tags: ["tutorial"], capabilities: [], domain: (args.domain as string) ?? "general", limit: 10 }))
    .map(r => ({ title: r.title, domain: r.domain, content: r.content.substring(0, 200) + "..." }));
});

registerTool("search_knowledge", async (args) => {
  return (await retrieveKnowledge({
    tags: (args.tags as string[]) ?? [], capabilities: [],
    domain: (args.domain as string) ?? "general", limit: 5,
  })).map(r => ({ title: r.title, content: r.content.substring(0, 200), score: r.matchScore }));
});

// ── Monitoring ─────────────────────────────────────────────

registerTool("get_dashboard", async () => {
  const dash = await getDashboard();
  const queueMetrics = getQueueMetrics?.() ?? null;
  return { ...dash, queue: queueMetrics };
});

// ── File Tools ─────────────────────────────────────────────

registerTool("read_file_content", async (args, tenantId) => {
  let fileId = args.file_id as string;
  if (fileId && !fileId.startsWith("01")) {
    const allFiles = await listFiles(tenantId, 50);
    const match = allFiles.find((f: any) => f.fileName.toLowerCase().includes(fileId.toLowerCase()));
    if (match) fileId = match.id;
  }
  const result = await readFileContent(fileId);
  if (!result) return { error: "File not found or cannot read" };
  return { fileName: result.fileName, content: result.content, truncated: result.truncated };
});

registerTool("send_file", async (args) => {
  const file = await getFile(args.file_id as string);
  if (!file) return { error: "File not found" };
  return { __send_file__: true, url: file.s3Url, fileName: file.fileName, mimeType: file.mimeType };
});

registerTool("analyze_image", async (args, tenantId) => {
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
});

registerTool("list_files", async (_args, tenantId) => {
  return await listFiles(tenantId, (_args.limit as number) ?? 20);
});

registerTool("get_file", async (args) => {
  return await getFile(args.file_id as string);
});

// ── User Management Tools ──────────────────────────────────

registerTool("set_user_role", async (args, tenantId) => {
  const db = getDb();
  const now = nowMs();
  const channel = (args.channel as string) ?? "telegram";
  let channelUserId = (args.channel_user_id as string) ?? "";

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
});

registerTool("list_users", async (_args, tenantId) => {
  const db = getDb();
  return await db.select({
    channelUserId: tenantUsers.channelUserId, channel: tenantUsers.channel,
    displayName: tenantUsers.displayName, role: tenantUsers.role, isActive: tenantUsers.isActive,
  }).from(tenantUsers).where(eq(tenantUsers.tenantId, tenantId));
});

// ── AI Config Tools (admin edits bot behavior via chat) ────

registerTool("update_ai_config", async (args, tenantId) => {
  const db = getDb();
  const { tenants } = await import("../db/schema.js");
  const tenant = (await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1))[0];
  if (!tenant) return { error: "Tenant not found" };
  const current = (tenant.aiConfig ?? {}) as Record<string, unknown>;

  const updates = args as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) {
    if (key === "rules" && Array.isArray(value)) {
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
});

registerTool("get_ai_config", async (_args, tenantId) => {
  const db = getDb();
  const { tenants: t } = await import("../db/schema.js");
  const tn = (await db.select().from(t).where(eq(t.id, tenantId)).limit(1))[0];
  return tn?.aiConfig ?? {};
});

// ── Agent Management Tools ─────────────────────────────────

registerTool("create_agent_template", async (args, tenantId) => {
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
    tenantId,
  });
  return { id: tmpl.id, name: tmpl.name, role: tmpl.role };
});

registerTool("list_agent_templates", async (args) => {
  const { listTemplates: lt } = await import("../modules/agents/template.service.js");
  return (await lt({ role: args.role as string, status: (args.status as string) ?? "active" }))
    .map(t => ({ id: t.id, name: t.name, role: t.role, engine: t.engine, autoSpawn: t.autoSpawn, status: t.status }));
});

registerTool("spawn_agent", async (args) => {
  const { agentPool: pool } = await import("../modules/agents/agent-pool.js");
  const spawned = await pool.spawnAgent(
    args.template_id as string,
    args.template_name as string,
    args.parent_agent_id as string,
    (args.count as number) ?? 1,
  );
  return spawned.map(r => ({ id: r.agent.id, name: r.agent.name, role: r.agent.role }));
});

registerTool("kill_agent", async (args) => {
  const { agentPool: pool } = await import("../modules/agents/agent-pool.js");
  await pool.killAgent(args.agent_id as string);
  return { killed: true, agent_id: args.agent_id };
});

registerTool("list_agents", async (args) => {
  const { listAgents: la } = await import("../modules/agents/agent.service.js");
  return (await la())
    .filter(a => {
      if (args.role && a.role !== args.role) return false;
      if (args.status && a.status !== args.status) return false;
      return a.status !== "deactivated";
    })
    .map(a => ({ id: a.id, name: a.name, role: a.role, status: a.status, templateId: a.templateId, performance: a.performanceScore, tasksCompleted: a.tasksCompleted }));
});

// ── Dynamic Collections (admin-defined tables) ─────────────

registerTool("create_collection", async (args, tenantId) => {
  return await createCollection({
    tenantId,
    name: args.name as string,
    description: (args.description as string) ?? undefined,
    fields: (args.fields as any[]) ?? [],
    createdBy: (args.created_by as string) ?? undefined,
  });
});

registerTool("list_collections", async (_args, tenantId) => {
  return await listCollections(tenantId);
});

registerTool("add_row", async (args, tenantId) => {
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
});

registerTool("list_rows", async (args, tenantId) => {
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

  if (result.hasMore) {
    return { rows: result.rows, total: result.total, showing: result.rows.length, hasMore: true, hint: `Còn ${result.total - result.rows.length} rows. Dùng offset=${result.rows.length} để xem tiếp.` };
  }
  return { rows: result.rows, total: result.total };
});

registerTool("update_row", async (args) => {
  return await updateRow(args.row_id as string, (args.data as Record<string, unknown>) ?? {});
});

registerTool("delete_row", async (args) => {
  const deleted = await deleteRow(args.row_id as string);
  return { deleted, row_id: args.row_id };
});

registerTool("search_all", async (args, tenantId) => {
  const rows = await searchAllRows(tenantId, (args.keyword as string) ?? undefined, (args.limit as number) ?? 20);
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
});

// ── DB Query Meta-tool (permission-checked) ────────────────

registerTool("db_query", async (args, tenantId, ctx) => {
  const db = getDb();
  const now = nowMs();
  const _currentUser = ctx.currentUser;
  const table = args.table as string;
  const action = args.action as string;
  const filter = (args.filter as Record<string, unknown>) ?? {};
  const data = (args.data as Record<string, unknown>) ?? {};

  if (!_currentUser) return { error: "No user context" };

  const ALLOWED_TABLES = [
    "form_templates", "workflow_templates", "business_rules",
    "collections", "collection_rows", "knowledge_entries",
  ];
  if (!ALLOWED_TABLES.includes(table)) {
    return { error: `Bảng "${table}" không được phép truy cập qua db_query` };
  }

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

  await logAudit({
    tenantId, userId: _currentUser.id, userName: _currentUser.name,
    userRole: _currentUser.role, action, resourceTable: table,
    resourceId: (filter.id as string) ?? undefined,
    afterData: action === "create" || action === "update" ? data : undefined,
  });

  return result;
});

registerTool("request_permission", async (args, tenantId, ctx) => {
  const _currentUser = ctx.currentUser;
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
});

// ── Form State Tools ───────────────────────────────────────

registerTool("start_form", async (args, tenantId, ctx) => {
  const db = getDb();
  const _currentSessionId = ctx.sessionId;
  if (!_currentSessionId) return { error: "No session" };
  const { formTemplates: ft } = await import("../db/schema.js");
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
});

registerTool("update_form_field", async (args, _tenantId, ctx) => {
  const _currentSessionId = ctx.sessionId;
  if (!_currentSessionId) return { error: "No session" };
  const state = await updateFormField(_currentSessionId, args.field_name as string, args.value);
  const next = state.pendingFields[0] ?? null;
  return {
    saved: true, field: args.field_name, value: args.value,
    step: state.currentStep, total: state.totalSteps,
    nextField: next, completed: state.status === "completed",
    data: state.data,
  };
});

registerTool("get_form_state", async (_args, _tenantId, ctx) => {
  const _currentSessionId = ctx.sessionId;
  if (!_currentSessionId) return { error: "No session" };
  const state = await getFormState(_currentSessionId);
  if (!state) return { noForm: true };
  return state;
});

registerTool("cancel_form", async (_args, _tenantId, ctx) => {
  const _currentSessionId = ctx.sessionId;
  if (!_currentSessionId) return { error: "No session" };
  await cancelFormSession(_currentSessionId);
  return { cancelled: true };
});

// ── Cron Tools ─────────────────────────────────────────────

registerTool("create_cron", async (args, tenantId, ctx) => {
  const _currentUser = ctx.currentUser;
  if (!_currentUser) return { error: "No user context" };
  const { createCron } = await import("../modules/cron/cron.service.js");
  const cron = await createCron({
    tenantId,
    name: args.name as string,
    schedule: args.schedule as string,
    action: args.action as string,
    args: (args.action_args as Record<string, unknown>) ?? {},
    notifyUserId: _currentUser.id,
    createdByUserId: _currentUser.id,
    createdByName: _currentUser.name,
  });
  return { id: cron.id, name: cron.name, schedule: cron.scheduleDescription, nextRun: new Date(cron.nextRunAt).toISOString() };
});

registerTool("list_crons", async (_args, tenantId) => {
  const { listCrons } = await import("../modules/cron/cron.service.js");
  const crons = await listCrons(tenantId);
  return crons.map(c => ({
    id: c.id, name: c.name, schedule: c.scheduleDescription,
    action: c.action, status: c.status, runCount: c.runCount,
    lastResult: c.lastResult?.substring(0, 100),
  }));
});

registerTool("delete_cron", async (args) => {
  const { deleteCron } = await import("../modules/cron/cron.service.js");
  await deleteCron(args.cron_id as string);
  return { deleted: true };
});

registerTool("pause_cron", async (args) => {
  const { pauseCron } = await import("../modules/cron/cron.service.js");
  await pauseCron(args.cron_id as string);
  return { paused: true };
});

registerTool("resume_cron", async (args) => {
  const { resumeCron } = await import("../modules/cron/cron.service.js");
  await resumeCron(args.cron_id as string);
  return { resumed: true };
});

// ── SSH Tools (Admin only) ─────────────────────────────────

registerTool("ssh_exec", async (args, _tenantId, ctx) => {
  const _currentUser = ctx.currentUser;
  if (!_currentUser || _currentUser.role !== "admin") return { error: "Chỉ admin mới dùng SSH" };
  const { classifyCommand, executeSSH, createPendingExec } = await import("../modules/ssh/ssh.service.js");

  const host = args.host as string;
  const command = args.command as string;
  const port = (args.port as number) ?? 2357;
  const user = (args.user as string) ?? "root";

  if (!host || !command) return { error: "Cần host và command" };

  const tier = classifyCommand(command);

  if (tier === "blocked") {
    return { error: `⛔ Lệnh bị chặn vì lý do bảo mật: ${command}` };
  }

  if (tier === "confirm") {
    const pending = createPendingExec({ host, port, user, command, requestedBy: _currentUser.id });
    return {
      __needs_confirm__: true,
      pendingId: pending.id,
      command,
      host,
      message: `⚠️ Lệnh này cần xác nhận:\n\n<code>${command}</code>\n\nServer: ${host}:${port}\n\nGõ <code>/confirm ${pending.id}</code> để thực thi\nGõ <code>/cancel ${pending.id}</code> để huỷ\n\n⏱ Hết hạn sau 5 phút`,
    };
  }

  const result = await executeSSH({ host, port, user, command });
  return {
    host,
    command,
    stdout: result.stdout.substring(0, 3000),
    stderr: result.stderr.substring(0, 500),
    exitCode: result.exitCode,
  };
});

registerTool("ssh_confirm", async (args, _tenantId, ctx) => {
  const _currentUser = ctx.currentUser;
  if (!_currentUser || _currentUser.role !== "admin") return { error: "Chỉ admin" };
  const { getPendingExec, deletePendingExec, executeSSH: execSSH } = await import("../modules/ssh/ssh.service.js");

  const pendingId = args.pending_id as string;
  const pending = getPendingExec(pendingId);
  if (!pending) return { error: "Không tìm thấy lệnh chờ hoặc đã hết hạn" };

  deletePendingExec(pendingId);
  const result = await execSSH({ host: pending.host, port: pending.port, user: pending.user, command: pending.command });
  return {
    confirmed: true,
    host: pending.host,
    command: pending.command,
    stdout: result.stdout.substring(0, 3000),
    stderr: result.stderr.substring(0, 500),
    exitCode: result.exitCode,
  };
});

// ── Bot Management Tools (Super Admin only) ────────────────

registerTool("create_bot", async (args, _tenantId, ctx) => {
  const db = getDb();
  const now = nowMs();
  const _currentUser = ctx.currentUser;
  if (!_currentUser || _currentUser.role !== "admin") return { error: "Chỉ admin mới tạo bot" };
  const botName = args.name as string;
  const botToken = args.token as string;
  const botPersona = (args.persona as string) ?? "trợ lý AI";
  if (!botName || !botToken) return { error: "Cần name và token" };

  const { superAdmins } = await import("../db/schema.js");
  const isSA = (await db.select().from(superAdmins)
    .where(and(eq(superAdmins.channel, "telegram"), eq(superAdmins.channelUserId, _currentUser.id)))
    .limit(1))[0];
  if (!isSA) return { error: "Chỉ Super Admin mới tạo bot" };

  const newTenantId = newId();
  const { tenants: tenantTable, tenantUsers: tuTable } = await import("../db/schema.js");

  await db.insert(tenantTable).values({
    id: newTenantId,
    name: `${botName} Corp`,
    botToken: botToken,
    botStatus: "active",
    config: "{}",
    aiConfig: JSON.stringify({
      bot_name: botName,
      bot_intro: botPersona,
      language: "vi",
      tone: "professional",
      rules: [
        "TUYỆT ĐỐI KHÔNG tự bịa/hallucinate data — chỉ trả lời dựa trên data thật từ tools hoặc knowledge base",
        "Khi user hỏi về file tài liệu (DOCX/PDF/TXT/CSV) → gọi read_file_content",
        "Khi user gửi hoặc hỏi về ẢNH (JPG/PNG/image) → gọi analyze_image. KHÔNG dùng read_file_content cho ảnh",
        "Khi user muốn lưu/tạo dữ liệu → dùng create_collection + add_row để LƯU VÀO DB THẬT",
        "Khi user hỏi xem dữ liệu → gọi list_rows/search_all, KHÔNG tự bịa",
        "KHÔNG tự tạo URL — gọi send_file(file_id) khi cần gửi file/ảnh",
        "search_all(keyword) để lọc — KHÔNG load hết rồi lọc text",
        "Kết quả > 20 rows → trả summary + hỏi xem chi tiết phần nào",
        "Ngắn gọn, thực tế, đúng trọng tâm",
        "Task nhiều bước → chạy hết TẤT CẢ cho đến khi HOÀN THÀNH, không dừng hỏi user giữa chừng",
        "Khi user thay đổi vai trò/persona/config → gọi update_ai_config để LƯU VÀO DB",
      ],
      tools: {
        business: [
          { name: "list_files", desc: "Xem files" },
          { name: "read_file_content", desc: "Đọc file", args: "file_id" },
          { name: "analyze_image", desc: "Phân tích ảnh (vision AI)", args: "file_id, prompt?" },
          { name: "send_file", desc: "Gửi file cho user", args: "file_id" },
          { name: "save_knowledge", desc: "Lưu knowledge" },
          { name: "search_knowledge", desc: "Tìm knowledge" },
          { name: "list_users", desc: "Xem users" },
          { name: "set_user_role", desc: "Đổi role", args: "channel_user_id, role" },
          { name: "get_dashboard", desc: "Dashboard" },
          { name: "create_collection", desc: "Tạo bảng", args: "name, fields" },
          { name: "list_collections", desc: "Xem bảng" },
          { name: "add_row", desc: "Thêm dòng", args: "collection, data" },
          { name: "list_rows", desc: "Xem dữ liệu", args: "collection" },
          { name: "update_row", desc: "Cập nhật dòng", args: "row_id, data" },
          { name: "delete_row", desc: "Xoá dòng", args: "row_id" },
          { name: "search_all", desc: "Tìm kiếm" },
          { name: "update_ai_config", desc: "Cập nhật config bot" },
          { name: "ssh_exec", desc: "Chạy lệnh SSH", args: "host, command, port?, user?" },
          { name: "create_agent_template", desc: "Tạo worker/persona", args: "name, role, system_prompt" },
          { name: "list_agents", desc: "Xem agents đang chạy" },
          { name: "create_bot", desc: "Tạo bot mới (Super Admin)", args: "name, token, persona?" },
          { name: "list_bots", desc: "Xem bots" },
          { name: "stop_bot", desc: "Dừng bot", args: "tenant_id" },
        ],
      },
      role_permissions: {
        admin: "ADMIN — toàn quyền",
        manager: "MANAGER — quản lý",
        user: "USER — sử dụng",
      },
    }),
    status: "active",
    createdAt: now,
    updatedAt: now,
    createdByUserId: _currentUser.id,
    createdByName: _currentUser.name,
  });

  await db.insert(tuTable).values({
    id: newId(),
    tenantId: newTenantId,
    channel: "telegram",
    channelUserId: _currentUser.id,
    displayName: _currentUser.name,
    role: "admin",
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  try {
    const { addBot } = await import("./telegram.bot.js");
    await addBot(newTenantId, botToken);
  } catch (e: any) {
    return { created: true, tenantId: newTenantId, botName, warning: `Bot created but polling failed: ${e.message}` };
  }

  return { created: true, tenantId: newTenantId, botName, status: "polling_started" };
});

registerTool("list_bots", async () => {
  const db = getDb();
  const { tenants: tt } = await import("../db/schema.js");
  const bots = await db.select({
    id: tt.id, name: tt.name, botUsername: tt.botUsername,
    botStatus: tt.botStatus, createdByName: tt.createdByName,
  }).from(tt).where(eq(tt.status, "active"));
  return bots;
});

registerTool("stop_bot", async (args, _tenantId, ctx) => {
  const db = getDb();
  const now = nowMs();
  const _currentUser = ctx.currentUser;
  if (!_currentUser || _currentUser.role !== "admin") return { error: "Chỉ admin" };
  const targetId = args.tenant_id as string;
  if (!targetId) return { error: "Cần tenant_id" };

  const { tenants: tt2 } = await import("../db/schema.js");
  await db.update(tt2).set({ botStatus: "stopped", updatedAt: now })
    .where(eq(tt2.id, targetId));

  try {
    const { removeBot } = await import("./telegram.bot.js");
    removeBot(targetId);
  } catch {}

  return { stopped: true, tenantId: targetId };
});
