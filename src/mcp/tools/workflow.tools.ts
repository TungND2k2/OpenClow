import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db/connection.js";
import {
  workflowTemplates,
  formTemplates,
  workflowInstances,
  workflowApprovals,
} from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";

export function registerWorkflowTools(server: McpServer): void {
  // ── Template CRUD ──
  server.tool("create_workflow_template", "Define a new workflow", {
    tenant_id: z.string(),
    name: z.string(),
    domain: z.string().optional(),
    stages: z.array(z.record(z.unknown())),
    description: z.string().optional(),
    trigger_config: z.record(z.unknown()).optional(),
  }, async (params) => {
    const db = getDb();
    const now = nowMs();
    const id = newId();
    await db.insert(workflowTemplates).values({
      id,
      tenantId: params.tenant_id,
      name: params.name,
      description: params.description ?? null,
      domain: params.domain ?? null,
      version: 1,
      stages: JSON.stringify(params.stages),
      triggerConfig: params.trigger_config ? JSON.stringify(params.trigger_config) : null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
    return { content: [{ type: "text", text: JSON.stringify({ id, name: params.name }, null, 2) }] };
  });

  server.tool("get_workflow_template", "Get template details", {
    template_id: z.string(),
  }, async ({ template_id }) => {
    const db = getDb();
    const row = (await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, template_id)).limit(1))[0];
    if (!row) return { content: [{ type: "text", text: "Not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  });

  server.tool("list_workflow_templates", "List templates for tenant", {
    tenant_id: z.string(),
    domain: z.string().optional(),
    status: z.string().optional(),
  }, async (params) => {
    const db = getDb();
    const conditions: any[] = [eq(workflowTemplates.tenantId, params.tenant_id)];
    if (params.domain) conditions.push(eq(workflowTemplates.domain, params.domain));
    if (params.status) conditions.push(eq(workflowTemplates.status, params.status as any));
    const rows = await db.select().from(workflowTemplates).where(and(...conditions));
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });

  server.tool("update_workflow_template", "Update template (new version)", {
    template_id: z.string(),
    stages: z.array(z.record(z.unknown())).optional(),
    status: z.enum(["draft", "active", "archived"]).optional(),
    description: z.string().optional(),
  }, async (params) => {
    const db = getDb();
    const updates: Record<string, any> = { updatedAt: nowMs() };
    if (params.stages) updates.stages = JSON.stringify(params.stages);
    if (params.status) updates.status = params.status;
    if (params.description) updates.description = params.description;
    await db.update(workflowTemplates).set(updates).where(eq(workflowTemplates.id, params.template_id));
    return { content: [{ type: "text", text: "OK" }] };
  });

  // ── Instance lifecycle ──
  server.tool("start_workflow", "Start a workflow instance", {
    template_id: z.string(),
    tenant_id: z.string(),
    initiated_by: z.string(),
    channel: z.enum(["telegram", "web", "api", "slack"]).optional(),
    initial_data: z.record(z.unknown()).optional(),
  }, async (params) => {
    const db = getDb();
    const now = nowMs();
    const id = newId();

    const template = (await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, params.template_id)).limit(1))[0];
    if (!template) return { content: [{ type: "text", text: "Template not found" }], isError: true };

    const stages = template.stages as unknown as any[];
    const firstStageId = stages.length > 0 ? stages[0].id : null;

    await db.insert(workflowInstances).values({
      id,
      templateId: params.template_id,
      tenantId: params.tenant_id,
      initiatedBy: params.initiated_by,
      currentStageId: firstStageId,
      status: "active",
      formData: params.initial_data ? JSON.stringify(params.initial_data) : "{}",
      contextData: "{}",
      channel: params.channel ?? null,
      history: JSON.stringify([{ stage: firstStageId, action: "started", at: now }]),
      createdAt: now,
      updatedAt: now,
    });
    return { content: [{ type: "text", text: JSON.stringify({ id, currentStageId: firstStageId }, null, 2) }] };
  });

  server.tool("get_workflow_instance", "Get instance status and data", {
    instance_id: z.string(),
  }, async ({ instance_id }) => {
    const db = getDb();
    const row = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, instance_id)).limit(1))[0];
    if (!row) return { content: [{ type: "text", text: "Not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  });

  server.tool("submit_form_data", "Submit form data for current stage", {
    instance_id: z.string(),
    form_data: z.record(z.unknown()),
  }, async ({ instance_id, form_data }) => {
    const db = getDb();
    const now = nowMs();
    const instance = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, instance_id)).limit(1))[0];
    if (!instance) return { content: [{ type: "text", text: "Not found" }], isError: true };

    const existing = (instance.formData as any) ?? {};
    const merged = { ...existing, ...form_data };
    await db.update(workflowInstances).set({
      formData: JSON.stringify(merged),
      updatedAt: now,
    }).where(eq(workflowInstances.id, instance_id));
    return { content: [{ type: "text", text: JSON.stringify({ formData: merged }, null, 2) }] };
  });

  server.tool("decide_approval", "Approve or reject a workflow stage", {
    approval_id: z.string(),
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().optional(),
    approver_id: z.string(),
  }, async (params) => {
    const db = getDb();
    const now = nowMs();
    await db.update(workflowApprovals).set({
      status: params.decision,
      decisionReason: params.reason ?? null,
      decidedAt: now,
    }).where(eq(workflowApprovals.id, params.approval_id));
    return { content: [{ type: "text", text: `${params.decision}` }] };
  });

  server.tool("list_workflow_instances", "List workflow instances", {
    tenant_id: z.string().optional(),
    status: z.string().optional(),
    template_id: z.string().optional(),
  }, async (params) => {
    const db = getDb();
    const conditions: any[] = [];
    if (params.tenant_id) conditions.push(eq(workflowInstances.tenantId, params.tenant_id));
    if (params.status) conditions.push(eq(workflowInstances.status, params.status as any));
    if (params.template_id) conditions.push(eq(workflowInstances.templateId, params.template_id));
    const rows = await db.select().from(workflowInstances)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(workflowInstances.createdAt))
      .limit(50);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });
}
