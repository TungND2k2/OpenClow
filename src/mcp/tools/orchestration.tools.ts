import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { decomposeTask, activatePlan, getPlan } from "../../modules/orchestration/decomposer.js";
import { selectBestAgentGlobal } from "../../modules/orchestration/decision-engine.js";
import { assignTask } from "../../modules/tasks/task.service.js";
import { recordDecision } from "../../modules/decisions/decision.service.js";

const subtaskSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  required_capabilities: z.array(z.string()).optional(),
  depends_on_indices: z.array(z.number()).optional(),
  estimated_duration_ms: z.number().optional(),
});

export function registerOrchestrationTools(server: McpServer): void {
  server.tool("decompose_task", "Decompose task into subtasks with execution plan", {
    task_id: z.string(),
    agent_id: z.string(),
    subtasks: z.array(subtaskSchema),
    strategy: z.enum(["sequential", "parallel", "pipeline", "mixed"]).optional(),
  }, async (params) => {
    try {
      const result = await decomposeTask({
        taskId: params.task_id,
        agentId: params.agent_id,
        subtasks: params.subtasks.map((s) => ({
          title: s.title,
          description: s.description,
          requiredCapabilities: s.required_capabilities,
          dependsOnIndices: s.depends_on_indices,
          estimatedDurationMs: s.estimated_duration_ms,
        })),
        strategy: params.strategy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  });

  server.tool("execute_plan", "Activate an execution plan", {
    plan_id: z.string(),
  }, async ({ plan_id }) => {
    try {
      await activatePlan(plan_id);
      return { content: [{ type: "text", text: "Plan activated" }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  });

  server.tool("get_plan_status", "View execution plan progress", {
    plan_id: z.string(),
  }, async ({ plan_id }) => {
    const plan = await getPlan(plan_id);
    if (!plan) return { content: [{ type: "text", text: "Plan not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
  });

  server.tool("delegate_task", "Assign task to a subordinate", {
    task_id: z.string(),
    from_agent_id: z.string(),
    to_agent_id: z.string(),
  }, async ({ task_id, from_agent_id, to_agent_id }) => {
    try {
      const task = await assignTask(task_id, to_agent_id, from_agent_id);
      await recordDecision({
        agentId: from_agent_id,
        decisionType: "assign",
        taskId: task_id,
        targetAgentId: to_agent_id,
        reasoning: `Manually delegated to ${to_agent_id}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  });

  server.tool("auto_assign_task", "Let decision engine pick best agent", {
    task_id: z.string(),
    requesting_agent_id: z.string(),
  }, async ({ task_id, requesting_agent_id }) => {
    try {
      const { getTask } = await import("../../modules/tasks/task.service.js");
      const task = await getTask(task_id);
      if (!task) return { content: [{ type: "text", text: "Task not found" }], isError: true };

      const best = await selectBestAgentGlobal(task.requiredCapabilities);
      if (!best) return { content: [{ type: "text", text: "No suitable agent found" }], isError: true };

      const updated = await assignTask(task_id, best.agentId, requesting_agent_id);
      await recordDecision({
        agentId: requesting_agent_id,
        decisionType: "assign",
        taskId: task_id,
        targetAgentId: best.agentId,
        reasoning: `Auto-assigned (score: ${best.score.toFixed(3)})`,
        inputContext: { ...best },
      });
      return { content: [{ type: "text", text: JSON.stringify({ task: updated, agent_score: best }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  });

  server.tool("create_execution_plan", "Create a DAG plan for a goal", {
    root_task_id: z.string(),
    agent_id: z.string(),
    plan_graph: z.object({
      nodes: z.array(z.object({
        taskId: z.string(),
        title: z.string(),
        requiredCapabilities: z.array(z.string()),
        dependsOn: z.array(z.string()),
      })),
      edges: z.array(z.object({ from: z.string(), to: z.string() })),
    }),
    strategy: z.enum(["sequential", "parallel", "pipeline", "mixed"]),
  }, async (params) => {
    try {
      const { getDb } = await import("../../db/connection.js");
      const { executionPlans } = await import("../../db/schema.js");
      const { newId } = await import("../../utils/id.js");
      const { nowMs } = await import("../../utils/clock.js");
      const db = getDb();
      const now = nowMs();
      const id = newId();
      await db.insert(executionPlans).values({
        id,
        rootTaskId: params.root_task_id,
        createdByAgentId: params.agent_id,
        strategy: params.strategy,
        planGraph: JSON.stringify(params.plan_graph),
        status: "draft",
        createdAt: now,
        updatedAt: now,
      });
      return { content: [{ type: "text", text: JSON.stringify({ id, status: "draft" }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  });
}
