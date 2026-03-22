import { eq } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { workflowTemplates, workflowInstances, workflowApprovals } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";
import { evaluateCondition, type RuleCondition } from "./rules-engine.service.js";
import { validateForm, type FormSchema } from "./form-engine.service.js";

export interface WorkflowStage {
  id: string;
  name: string;
  type: "form" | "validation" | "approval" | "action" | "notification" | "conditional";
  form_id?: string;
  rules_id?: string;
  approval_config?: { approver_role: string; auto_approve_rules_id?: string; escalation_timeout_ms?: number };
  action_config?: { integration_id: string; action_type: string; payload_template: Record<string, unknown> };
  notification_config?: { channel: string; template: string; recipients: string[] };
  conditional_config?: { rules_id: string; true_next: string; false_next: string };
  next_stage_id?: string;
  timeout_ms?: number;
}

export interface WorkflowInstance {
  id: string;
  templateId: string;
  tenantId: string;
  initiatedBy: string;
  currentStageId: string | null;
  status: "active" | "paused" | "completed" | "failed" | "cancelled";
  formData: Record<string, unknown>;
  contextData: Record<string, unknown>;
  channel: string | null;
  history: { stage: string; action: string; at: number }[];
}

async function loadInstance(instanceId: string): Promise<WorkflowInstance | null> {
  const db = getDb();
  const row = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId)).limit(1))[0];
  if (!row) return null;

  const parseJson = (val: unknown) => {
    if (typeof val === "string") try { return JSON.parse(val); } catch { return val; }
    return val ?? {};
  };

  return {
    ...row,
    formData: parseJson(row.formData),
    contextData: parseJson(row.contextData),
    history: parseJson(row.history) ?? [],
    status: row.status as any,
  };
}

async function loadStages(templateId: string): Promise<WorkflowStage[]> {
  const db = getDb();
  const tmpl = (await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, templateId)).limit(1))[0];
  if (!tmpl) return [];
  const raw = tmpl.stages;
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as WorkflowStage[]; } catch { return []; }
  }
  return (raw as unknown as WorkflowStage[]) ?? [];
}

/**
 * Start a new workflow instance.
 */
export async function startWorkflow(input: {
  templateId: string;
  tenantId: string;
  initiatedBy: string;
  channel?: string;
  initialData?: Record<string, unknown>;
}): Promise<WorkflowInstance> {
  const db = getDb();
  const now = nowMs();
  const id = newId();

  const stages = await loadStages(input.templateId);
  const firstStageId = stages.length > 0 ? stages[0].id : null;

  await db.insert(workflowInstances).values({
    id,
    templateId: input.templateId,
    tenantId: input.tenantId,
    initiatedBy: input.initiatedBy,
    currentStageId: firstStageId,
    status: "active",
    formData: JSON.stringify(input.initialData ?? {}),
    contextData: "{}",
    channel: (input.channel as "telegram" | "web" | "api" | "slack") ?? null,
    history: JSON.stringify([{ stage: firstStageId, action: "started", at: now }]),
    createdAt: now,
    updatedAt: now,
  });

  return (await loadInstance(id))!;
}

/**
 * Advance workflow to the next stage.
 */
export async function advanceStage(
  instanceId: string,
  nextStageId: string
): Promise<WorkflowInstance> {
  const db = getDb();
  const now = nowMs();
  const instance = await loadInstance(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);

  const history = [...instance.history, { stage: nextStageId, action: "advanced", at: now }];

  await db.update(workflowInstances).set({
    currentStageId: nextStageId,
    history: JSON.stringify(history),
    updatedAt: now,
  }).where(eq(workflowInstances.id, instanceId));

  return (await loadInstance(instanceId))!;
}

/**
 * Complete a workflow instance.
 */
export async function completeWorkflow(instanceId: string): Promise<WorkflowInstance> {
  const db = getDb();
  const now = nowMs();
  const instance = await loadInstance(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);

  const history = [...instance.history, { stage: "end", action: "completed", at: now }];

  await db.update(workflowInstances).set({
    status: "completed" as const,
    completedAt: now,
    history: JSON.stringify(history),
    updatedAt: now,
  }).where(eq(workflowInstances.id, instanceId));

  return (await loadInstance(instanceId))!;
}

/**
 * Submit form data and validate.
 */
export async function submitFormData(
  instanceId: string,
  formData: Record<string, unknown>,
  formSchema?: FormSchema
): Promise<{ instance: WorkflowInstance; valid: boolean; errors: { fieldId: string; message: string }[] }> {
  const db = getDb();
  const now = nowMs();
  const instance = await loadInstance(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);

  const merged = { ...instance.formData, ...formData };

  let valid = true;
  let errors: { fieldId: string; message: string }[] = [];
  if (formSchema) {
    const result = validateForm(formSchema, merged);
    valid = result.valid;
    errors = result.errors;
  }

  await db.update(workflowInstances).set({
    formData: JSON.stringify(merged),
    updatedAt: now,
  }).where(eq(workflowInstances.id, instanceId));

  return { instance: (await loadInstance(instanceId))!, valid, errors };
}

/**
 * Create an approval request for a workflow stage.
 */
export async function requestApproval(input: {
  instanceId: string;
  stageId: string;
  approverId: string;
}): Promise<string> {
  const db = getDb();
  const now = nowMs();
  const id = newId();
  await db.insert(workflowApprovals).values({
    id,
    instanceId: input.instanceId,
    stageId: input.stageId,
    approverId: input.approverId,
    status: "pending",
    createdAt: now,
  });
  return id;
}

/**
 * Process approval decision.
 */
export async function processApproval(
  approvalId: string,
  decision: "approved" | "rejected",
  reason?: string
): Promise<{ status: string }> {
  const db = getDb();
  const now = nowMs();
  await db.update(workflowApprovals).set({
    status: decision,
    decisionReason: reason ?? null,
    decidedAt: now,
  }).where(eq(workflowApprovals.id, approvalId));
  return { status: decision };
}

/**
 * Get the current stage of a workflow.
 */
export async function getCurrentStage(instanceId: string): Promise<WorkflowStage | null> {
  const instance = await loadInstance(instanceId);
  if (!instance || !instance.currentStageId) return null;
  const stages = await loadStages(instance.templateId);
  return stages.find((s) => s.id === instance.currentStageId) ?? null;
}
