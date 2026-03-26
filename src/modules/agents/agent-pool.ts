/**
 * Agent Pool — dynamic registry that spawns/kills agents from templates.
 *
 * On startup:
 *   1. Seed default templates if none exist
 *   2. Auto-spawn agents from templates with autoSpawn=true
 *   3. Load existing agents from DB → create runners
 *
 * At runtime:
 *   - spawnAgent(templateId) → creates agent + runner
 *   - killAgent(agentId) → deactivates agent, removes runner
 *   - Admin/Commander manages agents via Telegram tools
 */

import { AgentRunner, type LLMEngine, type ToolDefinition } from "./agent-runner.js";
import { registerAgent, heartbeat, listAgents, getAgent, updateAgentStatus, type AgentRecord } from "./agent.service.js";
import { createTemplate, getTemplate, getTemplateByName, listTemplates, type TemplateRecord } from "./template.service.js";
import { getDb } from "../../db/connection.js";
import { agents } from "../../db/schema.js";
import { eq } from "drizzle-orm";

// ── Master tool catalog ─────────────────────────────────────

export const AGENT_TOOLS: ToolDefinition[] = [
  { name: "list_workflows", description: "Xem danh sách quy trình", parameters: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "create_workflow", description: "Tạo quy trình mới", parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, domain: { type: "string" }, stages: { type: "array" } }, required: ["name", "stages"] } },
  { name: "create_form", description: "Tạo form mới", parameters: { type: "object", properties: { name: { type: "string" }, fields: { type: "array" } }, required: ["name", "fields"] } },
  { name: "create_rule", description: "Tạo business rule", parameters: { type: "object", properties: { name: { type: "string" }, domain: { type: "string" }, rule_type: { type: "string" }, conditions: { type: "object" }, actions: { type: "array" } }, required: ["name"] } },
  { name: "save_tutorial", description: "Lưu tutorial", parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, target_role: { type: "string" }, domain: { type: "string" } }, required: ["title", "content"] } },
  { name: "save_knowledge", description: "Lưu knowledge", parameters: { type: "object", properties: { type: { type: "string" }, title: { type: "string" }, content: { type: "string" }, domain: { type: "string" }, tags: { type: "array" } }, required: ["title", "content"] } },
  { name: "search_knowledge", description: "Tìm knowledge đã học", parameters: { type: "object", properties: { domain: { type: "string" }, tags: { type: "array" } } } },
  { name: "list_tutorials", description: "Xem tutorials", parameters: { type: "object", properties: { domain: { type: "string" } } } },
  { name: "list_files", description: "Xem file đã upload", parameters: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "read_file_content", description: "Đọc nội dung file (DOCX/TXT/CSV)", parameters: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] } },
  { name: "get_file", description: "Xem metadata file", parameters: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] } },
  { name: "send_file", description: "Gửi file cho user", parameters: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] } },
  { name: "list_users", description: "Xem users", parameters: { type: "object", properties: {} } },
  { name: "set_user_role", description: "Đổi role user", parameters: { type: "object", properties: { channel: { type: "string" }, channel_user_id: { type: "string" }, role: { type: "string" } }, required: ["channel", "channel_user_id", "role"] } },
  { name: "get_dashboard", description: "Dashboard hệ thống", parameters: { type: "object", properties: {} } },
  { name: "start_workflow_instance", description: "Bắt đầu workflow", parameters: { type: "object", properties: { template_id: { type: "string" }, initiated_by: { type: "string" } }, required: ["template_id"] } },
  // ── Agent management tools (admin/commander only) ──
  { name: "create_agent_template", description: "Tạo template agent mới (job description)", parameters: { type: "object", properties: { name: { type: "string" }, role: { type: "string", enum: ["supervisor", "specialist", "worker"] }, system_prompt: { type: "string" }, capabilities: { type: "array" }, tools: { type: "array" }, engine: { type: "string" }, max_concurrent_tasks: { type: "number" } }, required: ["name", "role", "system_prompt"] } },
  { name: "list_agent_templates", description: "Xem danh sách templates", parameters: { type: "object", properties: { role: { type: "string" }, status: { type: "string" } } } },
  { name: "spawn_agent", description: "Tạo agent từ template", parameters: { type: "object", properties: { template_id: { type: "string" }, template_name: { type: "string" }, parent_agent_id: { type: "string" }, count: { type: "number" } }, required: [] } },
  { name: "kill_agent", description: "Tắt agent", parameters: { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"] } },
  { name: "list_agents", description: "Xem agents đang chạy", parameters: { type: "object", properties: { role: { type: "string" }, status: { type: "string" } } } },
];

// ── Pool class ──────────────────────────────────────────────

class AgentPool {
  private runners = new Map<string, AgentRunner>();
  private toolExecutor: ((tool: string, args: Record<string, unknown>, tenantId: string) => Promise<unknown>) | null = null;

  // ── Init (called once at startup) ─────────────────────────

  async init(config: { toolExecutor: ((tool: string, args: Record<string, unknown>, tenantId: string) => Promise<unknown>) | null }): Promise<void> {
    this.toolExecutor = config.toolExecutor;

    // 1. Seed default templates if empty
    await this.seedDefaults();

    // 2. Auto-spawn from templates
    await this.autoSpawn();

    // 3. Load existing active agents → create runners
    const activeAgents = (await listAgents()).filter(a => a.status !== "deactivated");
    for (const agent of activeAgents) {
      await this.createRunner(agent);
      await heartbeat(agent.id);
    }

    const commander = this.getCommander();
    const workers = this.getRunnersByRole("worker");
    const supervisors = this.getRunnersByRole("supervisor");
    console.error(`[AgentPool] Ready (${commander ? 1 : 0} Commander, ${supervisors.length} Supervisors, ${workers.length} Workers)`);
  }

  // ── Spawn agent from template (runtime) ───────────────────

  async spawnAgent(templateId?: string, templateName?: string, parentAgentId?: string, count?: number): Promise<AgentRunner[]> {
    let template: TemplateRecord | null = null;

    if (templateId) template = await getTemplate(templateId);
    if (!template && templateName) template = await getTemplateByName(templateName);
    if (!template) throw new Error(`Template not found: ${templateId ?? templateName}`);
    if (template.status === "archived") throw new Error(`Template "${template.name}" is archived`);

    // Commander is singleton
    if (template.role === "commander" && this.getCommander()) {
      throw new Error("Commander already exists");
    }

    const spawnCount = count ?? 1;
    const spawned: AgentRunner[] = [];

    // Default parent: commander
    if (!parentAgentId) {
      const commander = this.getCommander();
      if (commander) parentAgentId = commander.agent.id;
    }

    const caps = typeof template.capabilities === "string"
      ? JSON.parse(template.capabilities) : template.capabilities;

    for (let i = 0; i < spawnCount; i++) {
      const existing = await this.getAgentsByTemplate(template.id);
      const idx = existing.length + 1;
      const name = spawnCount === 1 && idx === 1 ? template.name : `${template.name}-${idx}`;

      const agent = await registerAgent({
        name,
        role: template.role as any,
        capabilities: caps,
        parentAgentId,
        maxConcurrentTasks: template.maxConcurrentTasks,
        costBudgetUsd: template.costBudgetUsd ?? undefined,
        templateId: template.id,
      });

      await heartbeat(agent.id);
      const runner = await this.createRunner(agent, template);
      spawned.push(runner);
      console.error(`[AgentPool] Spawned: ${name} (${template.role}) from template "${template.name}"`);
    }

    return spawned;
  }

  // ── Kill agent (runtime) ──────────────────────────────────

  async killAgent(agentId: string): Promise<void> {
    const runner = this.runners.get(agentId);
    if (!runner) throw new Error(`Agent not found: ${agentId}`);
    if (runner.agent.role === "commander") throw new Error("Cannot kill Commander");

    await updateAgentStatus(agentId, "deactivated");
    this.runners.delete(agentId);
    console.error(`[AgentPool] Killed: ${runner.agent.name} (${agentId})`);
  }

  // ── Getters ───────────────────────────────────────────────

  getCommander(): AgentRunner | null {
    for (const runner of this.runners.values()) {
      if (runner.agent.role === "commander") return runner;
    }
    return null;
  }

  getRunner(agentId: string): AgentRunner | null {
    return this.runners.get(agentId) ?? null;
  }

  getRunnersByRole(role: string): AgentRunner[] {
    return [...this.runners.values()].filter(r => r.agent.role === role);
  }

  async getAvailableWorker(): Promise<AgentRunner | null> {
    for (const runner of this.runners.values()) {
      if (runner.agent.role === "worker") {
        const agent = await getAgent(runner.agent.id);
        if (agent && (agent.status === "idle" || agent.status === "busy")) return runner;
      }
    }
    return null;
  }

  getAllRunners(): AgentRunner[] {
    return [...this.runners.values()];
  }

  getToolDefinitions(): ToolDefinition[] {
    return AGENT_TOOLS;
  }

  // ── Private: create runner for agent ──────────────────────

  private async createRunner(agent: AgentRecord, template?: TemplateRecord | null): Promise<AgentRunner> {
    // Resolve template if not provided
    if (!template && agent.templateId) {
      template = await getTemplate(agent.templateId);
    }

    const engine: LLMEngine = (template?.engine as LLMEngine) ?? "fast-api";

    // Filter tools if template specifies
    let tools = AGENT_TOOLS;
    if (template?.tools) {
      const allowedTools = typeof template.tools === "string"
        ? JSON.parse(template.tools) : template.tools;
      if (Array.isArray(allowedTools) && allowedTools.length > 0) {
        tools = AGENT_TOOLS.filter(t => allowedTools.includes(t.name));
      }
    }

    const runner = new AgentRunner({
      agent: agent as any,
      engine,
      tools,
      systemPrompt: template?.systemPrompt ?? "",
      executeTool: async () => ({}), // Overridden per-request in agent-bridge
      maxToolLoops: template?.maxToolLoops ?? 5,
    });

    this.runners.set(agent.id, runner);
    return runner;
  }

  // ── Private: seed default templates on first boot ─────────

  private async seedDefaults(): Promise<void> {
    const existing = await listTemplates();
    if (existing.length > 0) {
      // Ensure Commander template uses claude-sdk
      const cmdTmpl = existing.find(t => t.role === "commander" && t.engine !== "claude-sdk");
      if (cmdTmpl) {
        const { updateTemplate } = await import("./template.service.js");
        await updateTemplate(cmdTmpl.id, { engine: "claude-sdk" });
        console.error("[AgentPool] Updated Commander template → claude-sdk");
      }
      return;
    }

    console.error("[AgentPool] First boot — seeding default templates...");

    await createTemplate({
      name: "Commander",
      role: "commander",
      systemPrompt: "Bạn là Commander — bộ não trung tâm. Phân tích yêu cầu, phân rã task phức tạp, giao cho Workers/Supervisors, tổng hợp kết quả.",
      capabilities: ["reasoning", "planning", "decomposition", "knowledge", "file-analysis"],
      tools: [], // all tools
      engine: "claude-sdk",
      maxConcurrentTasks: 5,
      autoSpawn: true,
      autoSpawnCount: 1,
    });

    await createTemplate({
      name: "General Worker",
      role: "worker",
      systemPrompt: "Bạn là Worker — thực thi task cụ thể. Dùng tools để hoàn thành công việc được giao. Báo cáo kết quả cho Supervisor/Commander.",
      capabilities: ["execution", "tool-use"],
      tools: [], // all tools
      engine: "fast-api",
      maxConcurrentTasks: 3,
      autoSpawn: true,
      autoSpawnCount: 3,
    });

    console.error("[AgentPool] Default templates created: Commander, General Worker");
  }

  // ── Private: auto-spawn from templates ────────────────────

  private async autoSpawn(): Promise<void> {
    const templates = await listTemplates({ status: "active" });
    const existingAgents = (await listAgents()).filter(a => a.status !== "deactivated");

    for (const tmpl of templates) {
      if (!tmpl.autoSpawn) continue;

      const current = existingAgents.filter(a => a.templateId === tmpl.id);
      const needed = tmpl.autoSpawnCount - current.length;

      if (needed <= 0) continue;

      console.error(`[AgentPool] Auto-spawning ${needed}x "${tmpl.name}"...`);

      // Find parent for non-commander agents
      let parentId: string | undefined;
      if (tmpl.role !== "commander") {
        const commander = existingAgents.find(a => a.role === "commander");
        parentId = commander?.id;
      }

      const caps = typeof tmpl.capabilities === "string"
        ? JSON.parse(tmpl.capabilities) : tmpl.capabilities;

      for (let i = 0; i < needed; i++) {
        const idx = current.length + i + 1;
        const name = tmpl.role === "commander" ? tmpl.name : `${tmpl.name}-${idx}`;

        const agent = await registerAgent({
          name,
          role: tmpl.role as any,
          capabilities: caps,
          parentAgentId: parentId,
          maxConcurrentTasks: tmpl.maxConcurrentTasks,
          costBudgetUsd: tmpl.costBudgetUsd ?? undefined,
          templateId: tmpl.id,
        });
        existingAgents.push(agent); // track for parent resolution
      }
    }
  }

  // ── Private: query agents by template ─────────────────────

  private async getAgentsByTemplate(templateId: string): Promise<AgentRecord[]> {
    return await getDb().select().from(agents)
      .where(eq(agents.templateId, templateId)) as AgentRecord[];
  }
}

// ── Singleton ───────────────────────────────────────────────

export const agentPool = new AgentPool();

// ── Backward-compatible exports ─────────────────────────────

export function getCommander(): AgentRunner | null { return agentPool.getCommander(); }
export function getWorkerRunners(): AgentRunner[] { return agentPool.getRunnersByRole("worker"); }
export function getAvailableWorker(): Promise<AgentRunner | null> { return agentPool.getAvailableWorker(); }
export function getRunnerByAgentId(agentId: string): AgentRunner | null { return agentPool.getRunner(agentId); }
export function getToolDefinitions(): ToolDefinition[] { return agentPool.getToolDefinitions(); }

// Backward compat: old init function redirects to new pool
export async function initAgentPool(config: { workerCount?: number; toolExecutor: any }): Promise<{ commander: AgentRunner; workers: AgentRunner[] }> {
  await agentPool.init({ toolExecutor: config.toolExecutor });
  return {
    commander: agentPool.getCommander()!,
    workers: agentPool.getRunnersByRole("worker"),
  };
}
