import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { tasks } from "./tasks.js";

// ============================================================
// messages
// ============================================================
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    fromAgentId: text("from_agent_id").notNull(), // no FK — allows "system"
    toAgentId: text("to_agent_id"),
    taskId: text("task_id").references(() => tasks.id),
    priority: integer("priority").notNull().default(3),
    payload: jsonb("payload").notNull(),
    status: text("status")
      .notNull()
      .default("pending"),
    expiresAt: bigint("expires_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    deliveredAt: bigint("delivered_at", { mode: "number" }),
    acknowledgedAt: bigint("acknowledged_at", { mode: "number" }),
  },
  (table) => [
    index("idx_messages_to_agent_status").on(table.toAgentId, table.status),
    index("idx_messages_task").on(table.taskId),
    index("idx_messages_created").on(table.createdAt),
  ]
);

// ============================================================
// decisions
// ============================================================
export const decisions = pgTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(), // no FK — allows "system" as agent
    decisionType: text("decision_type").notNull(),
    taskId: text("task_id").references(() => tasks.id),
    targetAgentId: text("target_agent_id"), // no FK — allows "system"
    reasoning: text("reasoning").notNull(),
    inputContext: jsonb("input_context"),
    outcome: text("outcome"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_decisions_agent").on(table.agentId),
    index("idx_decisions_task").on(table.taskId),
    index("idx_decisions_type").on(table.decisionType),
    index("idx_decisions_created").on(table.createdAt),
  ]
);

// ============================================================
// execution_plans
// ============================================================
export const executionPlans = pgTable(
  "execution_plans",
  {
    id: text("id").primaryKey(),
    rootTaskId: text("root_task_id")
      .notNull()
      .references(() => tasks.id),
    createdByAgentId: text("created_by_agent_id")
      .notNull()
      .references(() => agents.id),
    strategy: text("strategy").notNull(),
    planGraph: jsonb("plan_graph").notNull(),
    status: text("status")
      .notNull()
      .default("draft"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_exec_plans_root_task").on(table.rootTaskId),
    index("idx_exec_plans_status").on(table.status),
  ]
);
