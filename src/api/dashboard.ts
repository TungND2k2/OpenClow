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
import { newId } from "../utils/id.js";

export async function startDashboardAPI(port = 3102) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve web dashboard static files
  const path = await import("path");
  const webDist = path.resolve(process.cwd(), "web/dist");
  app.use(express.static(webDist));

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

  // ── Bot Docs (1 per tenant) ──────────────────────────
  app.get("/api/bots/:tenantId/docs", async (req, res) => {
    const rows = await db.execute(sql`SELECT * FROM bot_docs WHERE tenant_id = ${req.params.tenantId} LIMIT 1`);
    res.json((rows as any[])[0] ?? null);
  });

  app.put("/api/bots/:tenantId/docs", async (req, res) => {
    const { content } = req.body;
    const tenantId = req.params.tenantId;
    const existing = await db.execute(sql`SELECT id FROM bot_docs WHERE tenant_id = ${tenantId} LIMIT 1`);
    if ((existing as any[]).length > 0) {
      await db.execute(sql`UPDATE bot_docs SET content = ${content}, created_at = ${Date.now()} WHERE tenant_id = ${tenantId}`);
    } else {
      const { newId } = await import("../utils/id.js");
      await db.execute(sql`INSERT INTO bot_docs (id, tenant_id, title, content, created_at) VALUES (${newId()}, ${tenantId}, ${"Bot Knowledge"}, ${content}, ${Date.now()})`);
    }
    res.json({ ok: true });
  });

  // ── Bot Logs (persistent) ────────────────────────────
  app.get("/api/logs", async (req, res) => {
    const { getLogs } = await import("../modules/logs/bot-logger.js");
    const tenantId = req.query.tenant as string | undefined;
    const limit = parseInt(req.query.limit as string) || 200;
    const since = parseInt(req.query.since as string) || undefined;
    const rows = await getLogs(tenantId || undefined, limit, since);
    res.json(rows);
  });

  // ── CRUD: Collections ────────────────────────────────────
  app.post("/api/bots/:tenantId/collections", async (req, res) => {
    const { name, description, fields } = req.body;
    const now = Date.now();
    const slug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const id = newId();
    await db.insert(collections).values({ id, tenantId: req.params.tenantId, name, slug, description, fields: fields ?? [], createdAt: now, updatedAt: now });
    res.json({ id });
  });

  app.put("/api/collections/:id", async (req, res) => {
    const { name, description, fields } = req.body;
    await db.update(collections).set({ name, description, fields, updatedAt: Date.now() }).where(eq(collections.id, req.params.id));
    res.json({ ok: true });
  });

  app.delete("/api/collections/:id", async (req, res) => {
    await db.delete(collectionRows).where(eq(collectionRows.collectionId, req.params.id));
    await db.delete(collections).where(eq(collections.id, req.params.id));
    res.json({ ok: true });
  });

  app.post("/api/collections/:collectionId/rows", async (req, res) => {
    const now = Date.now();
    const id = newId();
    await db.insert(collectionRows).values({ id, collectionId: req.params.collectionId, data: req.body.data ?? req.body, createdAt: now, updatedAt: now });
    res.json({ id });
  });

  app.put("/api/collection-rows/:id", async (req, res) => {
    await db.update(collectionRows).set({ data: req.body.data ?? req.body, updatedAt: Date.now() }).where(eq(collectionRows.id, req.params.id));
    res.json({ ok: true });
  });

  app.delete("/api/collection-rows/:id", async (req, res) => {
    await db.delete(collectionRows).where(eq(collectionRows.id, req.params.id));
    res.json({ ok: true });
  });

  // ── CRUD: Forms ───────────────────────────────────────────
  app.post("/api/bots/:tenantId/forms", async (req, res) => {
    const { name, schema, uiHints, status } = req.body;
    const now = Date.now();
    const id = newId();
    await db.insert(formTemplates).values({ id, tenantId: req.params.tenantId, name, schema: schema ?? {}, uiHints, status: status ?? "active", createdAt: now, updatedAt: now });
    res.json({ id });
  });

  app.put("/api/forms/:id", async (req, res) => {
    const { name, schema, uiHints, status } = req.body;
    await db.update(formTemplates).set({ name, schema, uiHints, status, updatedAt: Date.now() }).where(eq(formTemplates.id, req.params.id));
    res.json({ ok: true });
  });

  app.delete("/api/forms/:id", async (req, res) => {
    await db.delete(formTemplates).where(eq(formTemplates.id, req.params.id));
    res.json({ ok: true });
  });

  // ── CRUD: Workflows ───────────────────────────────────────
  app.post("/api/bots/:tenantId/workflows", async (req, res) => {
    const { name, description, domain, stages, status } = req.body;
    const now = Date.now();
    const id = newId();
    await db.insert(workflowTemplates).values({ id, tenantId: req.params.tenantId, name, description, domain, stages: stages ?? [], status: status ?? "draft", createdAt: now, updatedAt: now });
    res.json({ id });
  });

  app.put("/api/workflows/:id", async (req, res) => {
    const { name, description, domain, stages, status } = req.body;
    await db.update(workflowTemplates).set({ name, description, domain, stages, status, updatedAt: Date.now() }).where(eq(workflowTemplates.id, req.params.id));
    res.json({ ok: true });
  });

  app.delete("/api/workflows/:id", async (req, res) => {
    await db.delete(workflowTemplates).where(eq(workflowTemplates.id, req.params.id));
    res.json({ ok: true });
  });

  // ── CRUD: Rules ───────────────────────────────────────────
  app.post("/api/bots/:tenantId/rules", async (req, res) => {
    const { name, description, domain, ruleType, conditions, actions, priority, status } = req.body;
    const now = Date.now();
    const id = newId();
    await db.insert(businessRules).values({ id, tenantId: req.params.tenantId, name, description, domain, ruleType: ruleType ?? "condition", conditions: conditions ?? [], actions: actions ?? [], priority: priority ?? 0, status: status ?? "active", createdAt: now, updatedAt: now });
    res.json({ id });
  });

  app.put("/api/rules/:id", async (req, res) => {
    const { name, description, domain, ruleType, conditions, actions, priority, status } = req.body;
    await db.update(businessRules).set({ name, description, domain, ruleType, conditions, actions, priority, status, updatedAt: Date.now() }).where(eq(businessRules.id, req.params.id));
    res.json({ ok: true });
  });

  app.delete("/api/rules/:id", async (req, res) => {
    await db.delete(businessRules).where(eq(businessRules.id, req.params.id));
    res.json({ ok: true });
  });

  // ── CRUD: Agent Templates ─────────────────────────────────
  app.post("/api/bots/:tenantId/agents", async (req, res) => {
    const { name, role, systemPrompt, capabilities, tools, engine, status } = req.body;
    const now = Date.now();
    const id = newId();
    await db.insert(agentTemplates).values({ id, tenantId: req.params.tenantId, name, role: role ?? "assistant", systemPrompt: systemPrompt ?? "", capabilities: capabilities ?? [], tools: tools ?? [], engine: engine ?? "fast-api", status: status ?? "active", createdAt: now, updatedAt: now });
    res.json({ id });
  });

  app.put("/api/agents/:id", async (req, res) => {
    const { name, role, systemPrompt, capabilities, tools, engine, status } = req.body;
    await db.update(agentTemplates).set({ name, role, systemPrompt, capabilities, tools, engine, status, updatedAt: Date.now() }).where(eq(agentTemplates.id, req.params.id));
    res.json({ ok: true });
  });

  app.delete("/api/agents/:id", async (req, res) => {
    await db.delete(agentTemplates).where(eq(agentTemplates.id, req.params.id));
    res.json({ ok: true });
  });

  // ── Delete: Knowledge ─────────────────────────────────────
  app.delete("/api/knowledge/:id", async (req, res) => {
    await db.delete(knowledgeEntries).where(eq(knowledgeEntries.id, req.params.id));
    res.json({ ok: true });
  });

  // ── Delete: Cron ──────────────────────────────────────────
  app.delete("/api/crons/:id", async (req, res) => {
    await db.execute(sql`DELETE FROM scheduled_tasks WHERE id = ${req.params.id}`);
    res.json({ ok: true });
  });

  // SPA fallback (Express 5 syntax)
  app.use((_req, res) => {
    try {
      res.sendFile(path.resolve(webDist, "index.html"));
    } catch { res.status(404).send("Not found"); }
  });

  const server = app.listen(port, "0.0.0.0", () => {
    console.error(`[Dashboard API] http://0.0.0.0:${port}`);
  });

  // ── WebSocket for real-time logs ──────────────────────
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ server, path: "/ws/logs" });

  // Intercept console.error to stream logs
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    // Broadcast to all connected clients
    for (const client of wss.clients) {
      if (client.readyState === 1) { // OPEN
        client.send(JSON.stringify({ type: "log", text: text.trimEnd(), ts: Date.now() }));
      }
    }
    return originalStderr(chunk, ...args);
  }) as any;

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "connected", text: "🟢 Live log stream connected", ts: Date.now() }));
  });
  console.error(`[Dashboard API] WebSocket logs: ws://0.0.0.0:${port}/ws/logs`);

  return app;
}
