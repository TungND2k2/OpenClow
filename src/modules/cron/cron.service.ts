/**
 * Cron Service — scheduled tasks that run automatically.
 *
 * Users create crons via chat → stored in DB → orchestrator checks every tick
 * → executes tool → sends result to user via Telegram.
 */

import { getDb } from "../../db/connection.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";
import { sql, eq, and, ne, lte } from "drizzle-orm";
import { pgTable, text, integer, bigint, jsonb } from "drizzle-orm/pg-core";

// ── Schema ──────────────────────────────────────────────
export const scheduledTasks = pgTable("scheduled_tasks", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  schedule: text("schedule").notNull(),
  scheduleDescription: text("schedule_description"),
  action: text("action").notNull(),
  args: jsonb("args").default({}),
  notifyUserId: text("notify_user_id"),
  status: text("status").notNull().default("active"),
  lastRunAt: bigint("last_run_at", { mode: "number" }),
  nextRunAt: bigint("next_run_at", { mode: "number" }).notNull(),
  runCount: integer("run_count").notNull().default(0),
  lastResult: text("last_result"),
  createdByUserId: text("created_by_user_id"),
  createdByName: text("created_by_name"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// ── Cron Expression Parser ──────────────────────────────

export function parseSchedule(schedule: string): { intervalMs: number; description: string } | null {
  const s = schedule.trim().toLowerCase();

  if (s === "@hourly" || s === "every 1h") return { intervalMs: 60 * 60 * 1000, description: "Mỗi giờ" };
  if (s === "@daily" || s === "every 1d") return { intervalMs: 24 * 60 * 60 * 1000, description: "Mỗi ngày" };
  if (s === "@weekly") return { intervalMs: 7 * 24 * 60 * 60 * 1000, description: "Mỗi tuần" };

  const everyMatch = s.match(/^every\s+(\d+)\s*(m|min|h|hour|d|day)s?$/);
  if (everyMatch) {
    const val = parseInt(everyMatch[1]);
    const unit = everyMatch[2][0];
    const multiplier = unit === "m" ? 60 * 1000 : unit === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return { intervalMs: val * multiplier, description: `Mỗi ${val}${unit === "m" ? " phút" : unit === "h" ? " giờ" : " ngày"}` };
  }

  const parts = s.split(/\s+/);
  if (parts.length === 5) {
    const [min, hour] = parts;
    if (min.startsWith("*/")) {
      const interval = parseInt(min.substring(2));
      return { intervalMs: interval * 60 * 1000, description: `Mỗi ${interval} phút` };
    }
    if (hour.startsWith("*/")) {
      const interval = parseInt(hour.substring(2));
      return { intervalMs: interval * 60 * 60 * 1000, description: `Mỗi ${interval} giờ` };
    }
    if (!min.includes("*") && !hour.includes("*")) {
      return { intervalMs: 24 * 60 * 60 * 1000, description: `Mỗi ngày lúc ${hour}:${min.padStart(2, "0")}` };
    }
  }

  return null;
}

// ── CRUD ─────────────────────────────────────────────────

export interface CronTask {
  id: string;
  tenantId: string;
  name: string;
  schedule: string;
  scheduleDescription: string;
  action: string;
  args: Record<string, unknown>;
  notifyUserId: string;
  status: string;
  lastRunAt: number | null;
  nextRunAt: number;
  runCount: number;
  lastResult: string | null;
  createdByUserId: string;
  createdByName: string;
}

let _crons: CronTask[] = [];

function rowToCron(row: any): CronTask {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    schedule: row.schedule,
    scheduleDescription: row.scheduleDescription ?? "",
    action: row.action,
    args: typeof row.args === "string" ? JSON.parse(row.args) : (row.args ?? {}),
    notifyUserId: row.notifyUserId ?? "",
    status: row.status,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    runCount: row.runCount ?? 0,
    lastResult: row.lastResult,
    createdByUserId: row.createdByUserId ?? "",
    createdByName: row.createdByName ?? "",
  };
}

export async function loadCrons(): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(scheduledTasks).where(eq(scheduledTasks.status, "active"));
  _crons = rows.map(rowToCron);
  console.error(`[Cron] Loaded ${_crons.length} active crons`);
}

export async function createCron(input: {
  tenantId: string;
  name: string;
  schedule: string;
  action: string;
  args: Record<string, unknown>;
  notifyUserId: string;
  createdByUserId: string;
  createdByName: string;
}): Promise<CronTask> {
  const db = getDb();
  const now = nowMs();
  const id = newId();

  const parsed = parseSchedule(input.schedule);
  if (!parsed) throw new Error(`Schedule không hợp lệ: ${input.schedule}`);

  const nextRunAt = now + parsed.intervalMs;

  await db.insert(scheduledTasks).values({
    id,
    tenantId: input.tenantId,
    name: input.name,
    schedule: input.schedule,
    scheduleDescription: parsed.description,
    action: input.action,
    args: input.args,
    notifyUserId: input.notifyUserId,
    status: "active",
    nextRunAt,
    runCount: 0,
    createdByUserId: input.createdByUserId,
    createdByName: input.createdByName,
    createdAt: now,
    updatedAt: now,
  });

  const cron: CronTask = {
    id, tenantId: input.tenantId, name: input.name,
    schedule: input.schedule, scheduleDescription: parsed.description,
    action: input.action, args: input.args,
    notifyUserId: input.notifyUserId, status: "active",
    lastRunAt: null, nextRunAt, runCount: 0, lastResult: null,
    createdByUserId: input.createdByUserId, createdByName: input.createdByName,
  };

  _crons.push(cron);
  return cron;
}

export async function listCrons(tenantId: string): Promise<CronTask[]> {
  const db = getDb();
  const rows = await db.select().from(scheduledTasks)
    .where(and(eq(scheduledTasks.tenantId, tenantId), ne(scheduledTasks.status, "deleted")));
  return rows.map(rowToCron);
}

export async function deleteCron(cronId: string): Promise<void> {
  const db = getDb();
  await db.update(scheduledTasks).set({ status: "deleted", updatedAt: nowMs() }).where(eq(scheduledTasks.id, cronId));
  _crons = _crons.filter(c => c.id !== cronId);
}

export async function pauseCron(cronId: string): Promise<void> {
  const db = getDb();
  await db.update(scheduledTasks).set({ status: "paused", updatedAt: nowMs() }).where(eq(scheduledTasks.id, cronId));
  const idx = _crons.findIndex(c => c.id === cronId);
  if (idx >= 0) _crons[idx].status = "paused";
}

export async function resumeCron(cronId: string): Promise<void> {
  const db = getDb();
  await db.update(scheduledTasks).set({ status: "active", updatedAt: nowMs() }).where(eq(scheduledTasks.id, cronId));
  const idx = _crons.findIndex(c => c.id === cronId);
  if (idx >= 0) _crons[idx].status = "active";
}

// ── Tick — called by orchestrator every 5s ──────────────

export async function tickCrons(
  executeTool: (tool: string, args: Record<string, unknown>, tenantId: string) => Promise<unknown>,
  sendNotification: (tenantId: string, userId: string, message: string) => Promise<void>,
): Promise<void> {
  const now = nowMs();
  const db = getDb();

  for (const cron of _crons) {
    if (cron.status !== "active") continue;
    if (now < cron.nextRunAt) continue;

    console.error(`[Cron] Running: ${cron.name} (${cron.action})`);

    try {
      const result = await executeTool(cron.action, cron.args, cron.tenantId);
      const resultStr = typeof result === "string" ? result : JSON.stringify(result).substring(0, 1000);

      const parsed = parseSchedule(cron.schedule);
      const nextRunAt = now + (parsed?.intervalMs ?? 60 * 60 * 1000);

      await db.update(scheduledTasks).set({
        lastRunAt: now,
        nextRunAt,
        runCount: sql`${scheduledTasks.runCount} + 1`,
        lastResult: resultStr,
        updatedAt: now,
      }).where(eq(scheduledTasks.id, cron.id));

      cron.lastRunAt = now;
      cron.nextRunAt = nextRunAt;
      cron.runCount++;
      cron.lastResult = resultStr;

      await sendNotification(
        cron.tenantId,
        cron.notifyUserId,
        `⏰ <b>Cron: ${cron.name}</b>\n\n${resultStr}`,
      );

      // Emit event for agent subscriptions
      try {
        const { emitEvent } = await import("../events/event-bus.js");
        const { handleEvent } = await import("../events/event-handler.js");
        const event = {
          type: "cron.executed",
          tenantId: cron.tenantId,
          collection: cron.action,
          data: { cronName: cron.name, result: resultStr },
          triggeredBy: "cron",
          timestamp: now,
        };
        await emitEvent(event);
        await handleEvent(event);
      } catch {}
    } catch (err: any) {
      console.error(`[Cron] Error ${cron.name}: ${err.message}`);

      const parsed = parseSchedule(cron.schedule);
      const nextRunAt = now + (parsed?.intervalMs ?? 60 * 60 * 1000);

      await db.update(scheduledTasks).set({
        nextRunAt,
        lastResult: `ERROR: ${err.message.substring(0, 200)}`,
        updatedAt: now,
      }).where(eq(scheduledTasks.id, cron.id));

      cron.nextRunAt = nextRunAt;
    }
  }
}
