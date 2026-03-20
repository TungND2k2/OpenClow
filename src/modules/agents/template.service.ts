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

export function createTemplate(input: CreateTemplateInput): TemplateRecord {
  const db = getDb();
  const now = nowMs();
  const id = newId();

  db.insert(agentTemplates).values({
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
    autoSpawn: input.autoSpawn ? 1 : 0,
    autoSpawnCount: input.autoSpawnCount ?? 1,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();

  return db.select().from(agentTemplates).where(eq(agentTemplates.id, id)).get()!;
}

// ── Read ────────────────────────────────────────────────────

export function getTemplate(id: string): TemplateRecord | null {
  return getDb().select().from(agentTemplates).where(eq(agentTemplates.id, id)).get() ?? null;
}

export function getTemplateByName(name: string): TemplateRecord | null {
  return getDb().select().from(agentTemplates).where(eq(agentTemplates.name, name)).get() ?? null;
}

export function listTemplates(filters?: { role?: string; status?: string }): TemplateRecord[] {
  const db = getDb();
  const conditions: any[] = [];

  if (filters?.role) conditions.push(eq(agentTemplates.role, filters.role as any));
  if (filters?.status) conditions.push(eq(agentTemplates.status, filters.status as any));

  if (conditions.length === 0) return db.select().from(agentTemplates).all();
  if (conditions.length === 1) return db.select().from(agentTemplates).where(conditions[0]).all();
  return db.select().from(agentTemplates).where(and(...conditions)).all();
}

// ── Update ──────────────────────────────────────────────────

export function updateTemplate(id: string, updates: Partial<CreateTemplateInput>): void {
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
  if (updates.autoSpawn !== undefined) values.autoSpawn = updates.autoSpawn ? 1 : 0;
  if (updates.autoSpawnCount !== undefined) values.autoSpawnCount = updates.autoSpawnCount;

  db.update(agentTemplates).set(values).where(eq(agentTemplates.id, id)).run();
}

// ── Archive ─────────────────────────────────────────────────

export function archiveTemplate(id: string): void {
  getDb().update(agentTemplates).set({ status: "archived", updatedAt: nowMs() }).where(eq(agentTemplates.id, id)).run();
}
