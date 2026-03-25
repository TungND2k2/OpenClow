/**
 * Prompt Builder — builds the Commander system prompt from DB config + registry.
 */

import { getToolListForPrompt } from "./tool-registry.js";

export function buildCommanderPrompt(
  tenantName: string, userName: string, userRole: string,
  aiConfig: Record<string, unknown>,
  instructions?: string,
): string {
  const cfg = aiConfig as any;
  const botName = cfg.bot_name ?? "Bot";
  const botIntro = cfg.bot_intro ?? "trợ lý AI";
  const rolePerms = cfg.role_permissions ?? {};
  const userPermissions = rolePerms[userRole] ?? `${userRole.toUpperCase()}`;
  const rules = (cfg.rules as string[]) ?? [];
  const customInstructions = (cfg.custom_instructions as string) ?? "";

  // Tool list from REGISTRY (source of truth) — not from ai_config
  const toolList = getToolListForPrompt();
  const toolInstructions = `Bạn có tools sau. Khi cần, output JSON block \`\`\`tool_calls để gọi:

${toolList}
Cách gọi tool:
\`\`\`tool_calls
[{"tool":"tên_t
ool","args":{"key":"value"}}]
\`\`\``;

  // Build rules
  const rulesText = rules.map((r: string) => `• ${r}`).join("\n");

  // Bot instructions (self-updating guide from DB)
  const botInstructions = instructions?.trim()
    ? `\n\nHƯỚNG DẪN CỦA BOT (đọc kỹ và tuân theo):\n${instructions.trim()}\n\nKhi học được pattern mới → gọi update_instructions(content, mode:"append") để lưu.`
    : "\nChưa có hướng dẫn. Khi user dạy quy trình/cách làm → gọi update_instructions để lưu lại.";

  // Use template from DB, or fallback
  const template = (cfg.prompt_template as string) ?? `Bạn là {{bot_name}} — {{bot_intro}} của {{tenant_name}}.

USER: {{user_name}} | ROLE: {{user_role}}
QUYỀN: {{user_permissions}}

{{tool_instructions}}
{{bot_instructions}}

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
    .replace(/\{\{bot_instructions\}\}/g, botInstructions)
    .replace(/\{\{custom_instructions\}\}/g, customInstructions)
    .trim();
}
