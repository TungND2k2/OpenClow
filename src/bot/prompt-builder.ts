/**
 * Prompt Builder — builds the Commander system prompt from DB config + registry.
 */

import { getToolListForPrompt } from "./tool-registry.js";

export function buildCommanderPrompt(
  tenantName: string, userName: string, userRole: string,
  aiConfig: Record<string, unknown>,
  nativeTools = false,
): string {
  const cfg = aiConfig as any;
  const botName = cfg.bot_name ?? "Bot";
  const botIntro = cfg.bot_intro ?? "trợ lý AI";
  const rolePerms = cfg.role_permissions ?? {};
  const userPermissions = rolePerms[userRole] ?? `${userRole.toUpperCase()}`;
  const rules = (cfg.rules as string[]) ?? [];
  const customInstructions = (cfg.custom_instructions as string) ?? "";

  // Tool list from REGISTRY (source of truth)
  const toolList = getToolListForPrompt();
  // Native tools (Anthropic API): just list names, no format block needed
  // Text tools (fast-api): include full format instructions
  const toolInstructions = nativeTools
    ? `Tools có sẵn:\n${toolList}`
    : `Tools có sẵn (gọi bằng JSON block \`\`\`tool_calls):\n\n${toolList}\nFormat: \`\`\`tool_calls\n[{"tool":"tên_tool","args":{"key":"value"}}]\n\`\`\``;

  const rulesText = rules.length > 0
    ? rules.map((r: string) => `• ${r}`).join("\n")
    : "• KHÔNG bịa data\n• Data đã được tải sẵn vào context (xem phần DỮ LIỆU ĐÃ TẢI SẴN bên dưới)\n• Dùng tools ADD/UPDATE/DELETE để ghi data — KHÔNG cần gọi list_rows nếu đã có trong context\n• Khi user nói 'nhớ/lưu' → gọi save_knowledge";

  const template = `Bạn là ${botName} — ${botIntro} của ${tenantName}.

USER: ${userName} | ROLE: ${userRole}
QUYỀN: ${userPermissions}

${toolInstructions}

QUY TẮC:
${rulesText}

${customInstructions}`.trim();

  return template;
}
