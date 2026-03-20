import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db/connection.js";
import { businessRules } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";

// ── Declarative rules engine (NO eval) ──

function getNestedValue(data: any, path: string): any {
  return path.split(".").reduce((obj, key) => obj?.[key], data);
}

function compare(fieldValue: any, operator: string, value: any): boolean {
  switch (operator) {
    case "eq": return fieldValue === value;
    case "neq": return fieldValue !== value;
    case "gt": return fieldValue > value;
    case "gte": return fieldValue >= value;
    case "lt": return fieldValue < value;
    case "lte": return fieldValue <= value;
    case "in": return Array.isArray(value) && value.includes(fieldValue);
    case "not_in": return Array.isArray(value) && !value.includes(fieldValue);
    case "contains": return typeof fieldValue === "string" && fieldValue.includes(value);
    case "matches": return typeof fieldValue === "string" && new RegExp(value).test(fieldValue);
    default: return false;
  }
}

function evaluateCondition(condition: any, data: any): boolean {
  switch (condition.type) {
    case "AND": return (condition.children ?? []).every((c: any) => evaluateCondition(c, data));
    case "OR": return (condition.children ?? []).some((c: any) => evaluateCondition(c, data));
    case "NOT": return !evaluateCondition(condition.children?.[0], data);
    case "comparison":
      const fieldValue = getNestedValue(data, condition.field ?? "");
      return compare(fieldValue, condition.operator ?? "eq", condition.value);
    default: return false;
  }
}

export function registerRulesTools(server: McpServer): void {
  server.tool("create_business_rule", "Define a business rule", {
    tenant_id: z.string(),
    name: z.string(),
    domain: z.string().optional(),
    rule_type: z.enum(["validation", "approval", "routing", "calculation", "auto_action"]),
    conditions: z.record(z.unknown()),
    actions: z.array(z.record(z.unknown())),
    description: z.string().optional(),
    priority: z.number().optional(),
  }, async (params) => {
    const db = getDb();
    const now = nowMs();
    const id = newId();
    await db.insert(businessRules).values({
      id,
      tenantId: params.tenant_id,
      name: params.name,
      description: params.description ?? null,
      domain: params.domain ?? null,
      ruleType: params.rule_type,
      conditions: JSON.stringify(params.conditions),
      actions: JSON.stringify(params.actions),
      priority: params.priority ?? 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { content: [{ type: "text", text: JSON.stringify({ id, name: params.name }, null, 2) }] };
  });

  server.tool("evaluate_rules", "Test rules against data", {
    rule_ids: z.array(z.string()),
    data: z.record(z.unknown()),
  }, async ({ rule_ids, data }) => {
    const db = getDb();
    const results: { ruleId: string; name: string; matched: boolean; actions: any[] }[] = [];

    for (const ruleId of rule_ids) {
      const rule = (await db.select().from(businessRules).where(eq(businessRules.id, ruleId)).limit(1))[0];
      if (!rule) continue;

      const conditions = rule.conditions as any;
      const matched = evaluateCondition(conditions, data);
      results.push({
        ruleId: rule.id,
        name: rule.name,
        matched,
        actions: matched ? (rule.actions as any) : [],
      });
    }
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.tool("list_business_rules", "List rules for tenant", {
    tenant_id: z.string(),
    domain: z.string().optional(),
    rule_type: z.string().optional(),
  }, async (params) => {
    const db = getDb();
    const conditions: any[] = [eq(businessRules.tenantId, params.tenant_id)];
    if (params.domain) conditions.push(eq(businessRules.domain, params.domain));
    if (params.rule_type) conditions.push(eq(businessRules.ruleType, params.rule_type as any));
    const rows = await db.select().from(businessRules).where(and(...conditions));
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });
}
