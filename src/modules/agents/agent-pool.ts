/**
 * Agent Pool — initializes and manages agent records + their runners.
 *
 * On startup:
 *   1. Check if Commander exists in DB → create if not
 *   2. Create N Worker agents
 *   3. Create AgentRunner for each (Commander → Claude SDK, Workers → fast API)
 *   4. Heartbeat all agents → set to "idle"
 *
 * LLMs are RESOURCES, not agents.
 * Agents are DB entities that USE LLMs to think.
 */

import { AgentRunner, type LLMEngine, type ToolDefinition } from "./agent-runner.js";
import { registerAgent, heartbeat, listAgents, getAgent, type AgentRecord } from "./agent.service.js";

// ── Singleton pool ──────────────────────────────────────────

let commanderRunner: AgentRunner | null = null;
const workerRunners: Map<string, AgentRunner> = new Map();
let _tools: ToolDefinition[] = [];
let _toolExecutor: ((tool: string, args: Record<string, unknown>, tenantId: string) => Promise<unknown>) | null = null;

// ── Tool definitions for agents ─────────────────────────────

const AGENT_TOOLS: ToolDefinition[] = [
  { name: "list_workflows", description: "Xem danh sách quy trình", parameters: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "create_workflow", description: "Tạo quy trình mới", parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, domain: { type: "string" }, stages: { type: "array" } }, required: ["name", "stages"] } },
  { name: "create_form", description: "Tạo form mới", parameters: { type: "object", properties: { name: { type: "string" }, fields: { type: "array" } }, required: ["name", "fields"] } },
  { name: "create_rule", description: "Tạo business rule", parameters: { type: "object", properties: { name: { type: "string" }, domain: { type: "string" }, rule_type: { type: "string" }, conditions: { type: "object" }, actions: { type: "array" } }, required: ["name"] } },
  { name: "save_tutorial", description: "Lưu tutorial", parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, target_role: { type: "string" }, domain: { type: "string" } }, required: ["title", "content"] } },
  { name: "save_knowledge", description: "Lưu knowledge", parameters: { type: "object", properties: { type: { type: "string" }, title: { type: "string" }, content: { type: "string" }, domain: { type: "string" }, tags: { type: "array" } }, required: ["title", "content"] } },
  { name: "search_knowledge", description: "Tìm knowledge đã học", parameters: { type: "object", properties: { domain: { type: "string" }, tags: { type: "array" } } } },
  { name: "list_tutorials", description: "Xem tutorials", parameters: { type: "object", properties: { domain: { type: "string" } } } },
  { name: "list_files", description: "Xem file đã upload", parameters: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "read_file_content", description: "Đọc nội dung file (DOCX/TXT/CSV) — DÙNG KHI USER HỎI VỀ NỘI DUNG FILE/CẨM NANG/TÀI LIỆU", parameters: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] } },
  { name: "get_file", description: "Xem metadata file", parameters: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] } },
  { name: "send_file", description: "Gửi file cho user", parameters: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] } },
  { name: "list_users", description: "Xem users", parameters: { type: "object", properties: {} } },
  { name: "set_user_role", description: "Đổi role user", parameters: { type: "object", properties: { channel: { type: "string" }, channel_user_id: { type: "string" }, role: { type: "string" } }, required: ["channel", "channel_user_id", "role"] } },
  { name: "get_dashboard", description: "Dashboard hệ thống", parameters: { type: "object", properties: {} } },
  { name: "start_workflow_instance", description: "Bắt đầu workflow", parameters: { type: "object", properties: { template_id: { type: "string" }, initiated_by: { type: "string" } }, required: ["template_id"] } },
];

// ── Initialize pool ─────────────────────────────────────────

export interface PoolConfig {
  workerCount?: number;
  toolExecutor: (tool: string, args: Record<string, unknown>, tenantId: string) => Promise<unknown>;
}

export function initAgentPool(config: PoolConfig): {
  commander: AgentRunner;
  workers: AgentRunner[];
} {
  _toolExecutor = config.toolExecutor;
  const workerCount = config.workerCount ?? 3;

  // ── 1. Find or create Commander ──────────────────────────
  const existingAgents = listAgents();
  let commanderRecord = existingAgents.find(a => a.role === "commander");

  if (!commanderRecord) {
    console.error("[AgentPool] Creating Commander agent...");
    commanderRecord = registerAgent({
      name: "Commander",
      role: "commander",
      capabilities: ["reasoning", "planning", "decomposition", "knowledge", "file-analysis"],
      maxConcurrentTasks: 5,
    });
  }
  heartbeat(commanderRecord.id);
  console.error(`[AgentPool] Commander: ${commanderRecord.id} (${commanderRecord.name})`);

  // ── 2. Find or create Workers ────────────────────────────
  let workerRecords = existingAgents.filter(a => a.role === "worker");

  while (workerRecords.length < workerCount) {
    const idx = workerRecords.length + 1;
    console.error(`[AgentPool] Creating Worker-${idx}...`);
    const worker = registerAgent({
      name: `Worker-${idx}`,
      role: "worker",
      capabilities: ["execution", "tool-use"],
      parentAgentId: commanderRecord.id,
      maxConcurrentTasks: 3,
    });
    workerRecords.push(worker);
  }

  for (const w of workerRecords) {
    heartbeat(w.id);
  }
  console.error(`[AgentPool] Workers: ${workerRecords.length} active`);

  // ── 3. Create runners (agent + brain) ────────────────────

  // Commander uses Claude SDK (powerful reasoning)
  commanderRunner = new AgentRunner({
    agent: commanderRecord as any,
    engine: "claude-sdk",
    tools: AGENT_TOOLS,
    systemPrompt: "", // Will be set per-request with context
    executeTool: async () => ({}), // Will be overridden per-request
    maxToolLoops: 5,
  });

  // Workers use fast API (quick, cheap)
  for (const w of workerRecords) {
    const runner = new AgentRunner({
      agent: w as any,
      engine: "fast-api",
      tools: AGENT_TOOLS,
      systemPrompt: "",
      executeTool: async () => ({}),
      maxToolLoops: 3,
    });
    workerRunners.set(w.id, runner);
  }

  console.error(`[AgentPool] Ready (1 Commander + ${workerRunners.size} Workers)`);

  return {
    commander: commanderRunner,
    workers: [...workerRunners.values()],
  };
}

// ── Getters ─────────────────────────────────────────────────

export function getCommander(): AgentRunner | null {
  return commanderRunner;
}

export function getWorkerRunners(): AgentRunner[] {
  return [...workerRunners.values()];
}

export function getAvailableWorker(): AgentRunner | null {
  // Find a worker whose agent is idle or has capacity
  for (const runner of workerRunners.values()) {
    const agent = getAgent(runner.agent.id);
    if (agent && (agent.status === "idle" || agent.status === "busy")) {
      return runner;
    }
  }
  return null;
}

export function getRunnerByAgentId(agentId: string): AgentRunner | null {
  if (commanderRunner && commanderRunner.agent.id === agentId) return commanderRunner;
  return workerRunners.get(agentId) ?? null;
}

export function getToolDefinitions(): ToolDefinition[] {
  return AGENT_TOOLS;
}
