/**
 * Dashboard API — lightweight Express server for web UI.
 * Serves read-only data from PostgreSQL.
 */

import express from "express";
import cors from "cors";
import { getDb } from "../db/connection.js";
import {
  tenants, tenantUsers, collections, collectionRows,
  files, knowledgeEntries, conversationSessions,
  formTemplates, workflowTemplates, businessRules,
  agentTemplates,
} from "../db/schema.js";
import { eq, sql, desc } from "drizzle-orm";

export function startDashboardAPI(port = 3102) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const db = getDb();

  // ── Overview ────────────────────────────────────────
  app.get("/api/overview", async (_req, res) => {
    const [
      tenantList,
      userCount,
      collectionCount,
      rowCount,
      fileCount,
      knowledgeCount,
      sessionCount,
    ] = await Promise.all([
      db.select({ id: tenants.id, name: tenants.name, botStatus: tenants.botStatus }).from(tenants).where(eq(tenants.status, "active")),
      db.select({ count: sql<number>`count(*)` }).from(tenantUsers),
      db.select({ count: sql<number>`count(*)` }).from(collections),
      db.select({ count: sql<number>`count(*)` }).from(collectionRows),
      db.select({ count: sql<number>`count(*)` }).from(files),
      db.select({ count: sql<number>`count(*)` }).from(knowledgeEntries),
      db.select({ count: sql<number>`count(*)` }).from(conversationSessions),
    ]);
    res.json({
      bots: tenantList,
      users: userCount[0]?.count ?? 0,
      collections: collectionCount[0]?.count ?? 0,
      rows: rowCount[0]?.count ?? 0,
      files: fileCount[0]?.count ?? 0,
      knowledge: knowledgeCount[0]?.count ?? 0,
      sessions: sessionCount[0]?.count ?? 0,
    });
  });

  // ── Bots (tenants) ──────────────────────────────────
  app.get("/api/bots", async (_req, res) => {
    const rows = await db.select().from(tenants).where(eq(tenants.status, "active"));
    res.json(rows.map(r => ({
      id: r.id,
      name: r.name,
      botStatus: r.botStatus,
      botUsername: r.botUsername,
      botName: (r.aiConfig as any)?.bot_name ?? r.name,
      thinking: (r.aiConfig as any)?.thinking ?? false,
      createdAt: r.createdAt,
    })));
  });

  // ── Users per tenant ────────────────────────────────
  app.get("/api/bots/:tenantId/users", async (req, res) => {
    const rows = await db.select().from(tenantUsers).where(eq(tenantUsers.tenantId, req.params.tenantId));
    res.json(rows);
  });

  // ── Collections per tenant ──────────────────────────
  app.get("/api/bots/:tenantId/collections", async (req, res) => {
    const cols = await db.select().from(collections).where(eq(collections.tenantId, req.params.tenantId));
    const result = [];
    for (const col of cols) {
      const count = await db.select({ count: sql<number>`count(*)` }).from(collectionRows).where(eq(collectionRows.collectionId, col.id));
      result.push({ ...col, rowCount: count[0]?.count ?? 0 });
    }
    res.json(result);
  });

  // ── Rows in collection ──────────────────────────────
  app.get("/api/collections/:collectionId/rows", async (req, res) => {
    const rows = await db.select().from(collectionRows)
      .where(eq(collectionRows.collectionId, req.params.collectionId))
      .orderBy(desc(collectionRows.createdAt))
      .limit(100);
    res.json(rows);
  });

  // ── Files per tenant ────────────────────────────────
  app.get("/api/bots/:tenantId/files", async (req, res) => {
    const rows = await db.select().from(files)
      .where(eq(files.tenantId, req.params.tenantId))
      .orderBy(desc(files.createdAt));
    res.json(rows);
  });

  // ── Knowledge per tenant ────────────────────────────
  app.get("/api/bots/:tenantId/knowledge", async (req, res) => {
    const rows = await db.select().from(knowledgeEntries)
      .where(eq(knowledgeEntries.tenantId, req.params.tenantId))
      .orderBy(desc(knowledgeEntries.usageCount));
    res.json(rows);
  });

  // ── Sessions per tenant ─────────────────────────────
  app.get("/api/bots/:tenantId/sessions", async (req, res) => {
    const rows = await db.select().from(conversationSessions)
      .where(eq(conversationSessions.tenantId, req.params.tenantId));
    res.json(rows.map(r => ({
      id: r.id,
      channelUserId: r.channelUserId,
      userName: r.userName,
      stateSize: JSON.stringify(r.state).length,
      messageCount: ((r.state as any)?.messages ?? []).length,
      createdAt: r.createdAt,
    })));
  });

  // ── Forms per tenant ────────────────────────────────
  app.get("/api/bots/:tenantId/forms", async (req, res) => {
    const rows = await db.select().from(formTemplates)
      .where(eq(formTemplates.tenantId, req.params.tenantId));
    res.json(rows);
  });

  // ── Workflows per tenant ────────────────────────────
  app.get("/api/bots/:tenantId/workflows", async (req, res) => {
    const rows = await db.select().from(workflowTemplates)
      .where(eq(workflowTemplates.tenantId, req.params.tenantId));
    res.json(rows);
  });

  // ── Rules per tenant ────────────────────────────────
  app.get("/api/bots/:tenantId/rules", async (req, res) => {
    const rows = await db.select().from(businessRules)
      .where(eq(businessRules.tenantId, req.params.tenantId));
    res.json(rows);
  });

  // ── Agents per tenant ───────────────────────────────
  app.get("/api/bots/:tenantId/agents", async (req, res) => {
    const rows = await db.select().from(agentTemplates)
      .where(eq(agentTemplates.tenantId, req.params.tenantId));
    res.json(rows);
  });

  // ── Crons per tenant ────────────────────────────────
  app.get("/api/bots/:tenantId/crons", async (req, res) => {
    const rows = await db.execute(sql`SELECT * FROM scheduled_tasks WHERE tenant_id = ${req.params.tenantId}`);
    res.json(rows);
  });

  app.listen(port, "0.0.0.0", () => {
    console.error(`[Dashboard API] http://0.0.0.0:${port}`);
  });

  return app;
}
