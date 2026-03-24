/**
 * Prompt Builder — builds the Commander system prompt from DB config.
 */

export function buildCommanderPrompt(
  tenantName: string, userName: string, userRole: string,
  aiConfig: Record<string, unknown>
): string {
  const cfg = aiConfig as any;
  const botName = cfg.bot_name ?? "Bot";
  const botIntro = cfg.bot_intro ?? "trợ lý AI";
  const rolePerms = cfg.role_permissions ?? {};
  const userPermissions = rolePerms[userRole] ?? `${userRole.toUpperCase()}`;
  // All rules from DB — no hardcode
  const rules = (cfg.rules as string[]) ?? [];
  const customInstructions = (cfg.custom_instructions as string) ?? "";

  // Build tool instructions from DB config
  const tools = cfg.tools ?? {};
  let toolInstructions = "Bạn có tools sau. Khi cần, output JSON block ```tool_calls để gọi:\n";

  let idx = 1;
  for (const [category, toolList] of Object.entries(tools)) {
    const label = category === "business" ? "Business" : category === "agent_management" ? "Agent Management (ADMIN only)" : category;
    toolInstructions += `\nTools — ${label}:\n`;
    for (const t of toolList as any[]) {
      toolInstructions += `${idx}. ${t.name}(${t.args ?? ""}) — ${t.desc}\n`;
      idx++;
    }
  }

  toolInstructions += `\nCách gọi tool:\n\`\`\`tool_calls\n[{"tool":"tên_tool","args":{"key":"value"}}]\n\`\`\``;

  // Build rules
  const rulesText = rules.map((r: string) => `• ${r}`).join("\n");

  // Use template from DB, or fallback
  const template = (cfg.prompt_template as string) ?? `Bạn là {{bot_name}} — {{bot_intro}} của {{tenant_name}}.

USER: {{user_name}} | ROLE: {{user_role}}
QUYỀN: {{user_permissions}}

{{tool_instructions}}

QUY TẮC:
{{rules}}

{{custom_instructions}}`;

  return template
    .replace(/\{\{bot_name\}\}/g, botName)
    .replace(/\{\{bot_intro\}\}/g, botIntro)
    .replace(/\{\{tenant_name\}\}/g, tenantName)
    .replace(/\{\{user_name\}\}/g, userName)
    .replace(/\{\{user_role\}\}/g, userRole)
    .replace(/\{\{user_permissions\}\}/g, userPermissions)
    .replace(/\{\{tool_instructions\}\}/g, toolInstructions)
    .replace(/\{\{rules\}\}/g, rulesText)
    .replace(/\{\{custom_instructions\}\}/g, customInstructions)
    .trim();
}
