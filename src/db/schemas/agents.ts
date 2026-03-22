import {
  pgTable,
  text,
  integer,
  bigint,
  real,
  boolean,
  jsonb,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

// ============================================================
// agent_templates — "job descriptions" for spawning agents
// ============================================================
export const agentTemplates = pgTable(
  "agent_templates",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    role: text("role").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    capabilities: jsonb("capabilities").notNull().default([]),
    tools: jsonb("tools").notNull().default([]), // empty = all tools
    engine: text("engine").notNull().default("fast-api"),
    maxConcurrentTasks: integer("max_concurrent_tasks").notNull().default(1),
    maxToolLoops: integer("max_tool_loops").notNull().default(5),
    costBudgetUsd: real("cost_budget_usd"),
    autoSpawn: boolean("auto_spawn").notNull().default(false),
    autoSpawnCount: integer("auto_spawn_count").notNull().default(1),
    status: text("status").notNull().default("active"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_templates_role").on(table.role),
    index("idx_templates_status").on(table.status),
  ]
);

// ============================================================
// agents — instances spawned from templates
// ============================================================
export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    templateId: text("template_id").references(() => agentTemplates.id),
    role: text("role").notNull(),
    authorityLevel: integer("authority_level").notNull(),
    capabilities: jsonb("capabilities")
      .notNull()
      .default([]),
    parentAgentId: text("parent_agent_id").references(
      (): any => agents.id
    ),
    status: text("status")
      .notNull()
      .default("registering"),
    performanceScore: real("performance_score").notNull().default(0.5),
    tasksCompleted: integer("tasks_completed").notNull().default(0),
    tasksFailed: integer("tasks_failed").notNull().default(0),
    maxConcurrentTasks: integer("max_concurrent_tasks").notNull().default(1),
    costBudgetUsd: real("cost_budget_usd"),
    costSpentUsd: real("cost_spent_usd").notNull().default(0.0),
    config: jsonb("config").default({}),
    lastHeartbeat: bigint("last_heartbeat", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_agents_status").on(table.status),
    index("idx_agents_role").on(table.role),
    index("idx_agents_parent").on(table.parentAgentId),
    index("idx_agents_template").on(table.templateId),
  ]
);

// ============================================================
// agent_hierarchy (closure table)
// ============================================================
export const agentHierarchy = pgTable(
  "agent_hierarchy",
  {
    ancestorId: text("ancestor_id")
      .notNull()
      .references(() => agents.id),
    descendantId: text("descendant_id")
      .notNull()
      .references(() => agents.id),
    depth: integer("depth").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ancestorId, table.descendantId] }),
    index("idx_hierarchy_descendant").on(table.descendantId),
    index("idx_hierarchy_depth").on(table.depth),
  ]
);
