/**
 * Template Service — CRUD for agent templates (job descriptions).
 * Templates define how agents behave: system prompt, tools, capabilities, engine.
 * Admin/Commander creates templates; agents are spawned from them at runtime.
 */

import { getDb } from "../../db/connection.js";
import { agentTemplates } from "../../db/schema.js";
import { eq, and } from "drizzle-orm";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";

export interface CreateTemplateInput {
  name: string;
  role: "commander" | "supervisor" | "specialist" | "worker";
  systemPrompt: string;
  capabilities?: string[];
  tools?: string[];         // empty = all tools allowed
  engine?: "claude-sdk" | "fast-api";
  maxConcurrentTasks?: number;
  maxToolLoops?: number;
  costBudgetUsd?: number;
  autoSpawn?: boolean;
  autoSpawnCount?: number;
}

export type TemplateRecord = typeof agentTemplates.$inferSelect;

// ── Create ──────────────────────────────────────────────────

export async function createTemplate(input: CreateTemplateInput): Promise<TemplateRecord> {
  const db = getDb();
  const now = nowMs();
  const id = newId();

  await db.insert(agentTemplates).values({
    id,
    name: input.name,
    role: input.role,
    systemPrompt: input.systemPrompt,
    capabilities: JSON.stringify(input.capabilities ?? []),
    tools: JSON.stringify(input.tools ?? []),
    engine: input.engine ?? "fast-api",
    maxConcurrentTasks: input.maxConcurrentTasks ?? 1,
    maxToolLoops: input.maxToolLoops ?? 5,
    costBudgetUsd: input.costBudgetUsd ?? null,
    autoSpawn: input.autoSpawn ?? false,
    autoSpawnCount: input.autoSpawnCount ?? 1,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  return (await db.select().from(agentTemplates).where(eq(agentTemplates.id, id)).limit(1))[0]!;
}

// ── Read ────────────────────────────────────────────────────

export async function getTemplate(id: string): Promise<TemplateRecord | null> {
  return (await getDb().select().from(agentTemplates).where(eq(agentTemplates.id, id)).limit(1))[0] ?? null;
}

export async function getTemplateByName(name: string): Promise<TemplateRecord | null> {
  return (await getDb().select().from(agentTemplates).where(eq(agentTemplates.name, name)).limit(1))[0] ?? null;
}

export async function listTemplates(filters?: { role?: string; status?: string }): Promise<TemplateRecord[]> {
  const db = getDb();
  const conditions: any[] = [];

  if (filters?.role) conditions.push(eq(agentTemplates.role, filters.role as any));
  if (filters?.status) conditions.push(eq(agentTemplates.status, filters.status as any));

  if (conditions.length === 0) return await db.select().from(agentTemplates);
  if (conditions.length === 1) return await db.select().from(agentTemplates).where(conditions[0]);
  return await db.select().from(agentTemplates).where(and(...conditions));
}

// ── Update ──────────────────────────────────────────────────

export async function updateTemplate(id: string, updates: Partial<CreateTemplateInput>): Promise<void> {
  const db = getDb();
  const values: Record<string, unknown> = { updatedAt: nowMs() };

  if (updates.name !== undefined) values.name = updates.name;
  if (updates.role !== undefined) values.role = updates.role;
  if (updates.systemPrompt !== undefined) values.systemPrompt = updates.systemPrompt;
  if (updates.capabilities !== undefined) values.capabilities = JSON.stringify(updates.capabilities);
  if (updates.tools !== undefined) values.tools = JSON.stringify(updates.tools);
  if (updates.engine !== undefined) values.engine = updates.engine;
  if (updates.maxConcurrentTasks !== undefined) values.maxConcurrentTasks = updates.maxConcurrentTasks;
  if (updates.maxToolLoops !== undefined) values.maxToolLoops = updates.maxToolLoops;
  if (updates.costBudgetUsd !== undefined) values.costBudgetUsd = updates.costBudgetUsd;
  if (updates.autoSpawn !== undefined) values.autoSpawn = updates.autoSpawn;
  if (updates.autoSpawnCount !== undefined) values.autoSpawnCount = updates.autoSpawnCount;

  await db.update(agentTemplates).set(values).where(eq(agentTemplates.id, id));
}

// ── Archive ─────────────────────────────────────────────────

export async function archiveTemplate(id: string): Promise<void> {
  await getDb().update(agentTemplates).set({ status: "archived", updatedAt: nowMs() }).where(eq(agentTemplates.id, id));
}
