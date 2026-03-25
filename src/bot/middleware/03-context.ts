/**
 * Context Middleware — builds file list, form state, and onboarding context.
 */

import { listFiles } from "../../modules/storage/s3.service.js";
import { getFormState } from "../../modules/conversations/conversation.service.js";
import { getPersonas } from "../../modules/agents/persona-conversation.js";
import { getResourceSummary, buildResourceSummary, formatSummaryForPrompt } from "../../modules/cache/resource-cache.js";
import { buildCommanderPrompt } from "../prompt-builder.js";
import type { PipelineContext } from "./types.js";

export async function contextMiddleware(ctx: PipelineContext): Promise<void> {
  // ── Resource cache (no DB query if cached) ────────────
  let summary = getResourceSummary(ctx.tenantId);
  if (!summary) {
    summary = await buildResourceSummary(ctx.tenantId);
  }
  const resourceContext = formatSummaryForPrompt(summary);
  console.error(`[Context] Resources: ${summary.forms.length} forms, ${summary.collections.length} collections, ${summary.filesCount} files`);

  // ── File list (for file IDs in prompt) ────────────────
  const uploadedFiles = await listFiles(ctx.tenantId, 20);
  ctx.fileContext = uploadedFiles.length > 0
    ? `\n\nFILES:\n${uploadedFiles.map((f: any) => `• ${f.fileName} (ID: ${f.id})`).join("\n")}`
    : "";
  ctx.fileContext += resourceContext;

  // ── Form state context ──────────────────────────────────
  ctx.formContext = "";
  if (ctx.sessionId) {
    const formState = await getFormState(ctx.sessionId);
    if (formState && formState.status === "in_progress") {
      const filled = Object.entries(formState.data)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v], i) => `  ${i + 1}. ${k}: ${v} ✅`)
        .join("\n");
      const pending = formState.pendingFields
        .map((f, i) => `  ${Object.keys(formState.data).length + i + 1}. ${f}${i === 0 ? " ← ĐANG CHỜ" : ""}`)
        .join("\n");
      ctx.formContext = `\n\nFORM ĐANG NHẬP: "${formState.formName}" (bước ${formState.currentStep}/${formState.totalSteps})
ĐÃ ĐIỀN:\n${filled || "  (chưa có)"}
ĐANG CHỜ:\n${pending || "  (hoàn thành)"}
→ Khi user trả lời → gọi update_form_field(field_name, value) để lưu. KHÔNG hỏi lại field đã điền.`;
    }
  }

  // ── Onboarding context — guide user proactively ─────────
  ctx.onboardingContext = "";
  try {
    const collections = summary.collections;
    const uploadedFileCount = summary.filesCount;
    const workerTemplates = await getPersonas(ctx.tenantId);
    const { listCrons } = await import("../../modules/cron/cron.service.js");
    const crons = await listCrons(ctx.tenantId);

    const hasCollections = collections.length > 0;
    const hasFiles = uploadedFileCount > 0;
    const hasWorkers = workerTemplates.length > 0;
    const hasCrons = crons.length > 0;
    const cfg = ctx.aiConfig as any;
    const persona = cfg.persona ?? cfg.bot_intro ?? "";

    // Detect if bot is newly configured but empty
    const isNewBot = !hasCollections && !hasFiles && !hasWorkers && !hasCrons;
    const isPartialSetup = (hasCollections || hasFiles) && (!hasWorkers || !hasCrons);

    if (isNewBot && persona) {
      ctx.onboardingContext = `\n\nONBOARDING — BOT MỚI CONFIG:
Bot persona: "${persona}"
Hiện tại bot CHƯA CÓ gì: không collections, không files, không workers, không crons.
→ BẠN PHẢI CHỦ ĐỘNG hỏi user:
  1. Công ty/tổ chức làm gì? Sản phẩm/dịch vụ chính?
  2. Bao nhiêu người dùng bot? Roles gì?
  3. Cần quản lý gì nhất? (đơn hàng, dự án, khách hàng...)
  4. Có sẵn tài liệu/cẩm nang nào không?
→ Sau khi hiểu → ĐỀ XUẤT tạo workers, collections, forms, crons phù hợp
→ KHÔNG CHỜ user hỏi — BẠN hỏi trước`;
    } else if (isPartialSetup) {
      const missing: string[] = [];
      if (!hasWorkers) missing.push("workers (nhân sự AI chuyên biệt)");
      if (!hasCrons) missing.push("cron (tự động báo cáo/nhắc nhở)");
      if (!hasFiles) missing.push("tài liệu (cẩm nang, hướng dẫn)");

      ctx.onboardingContext = `\n\nONBOARDING — CHƯA HOÀN THÀNH:
Đã có: ${hasCollections ? collections.length + " bảng dữ liệu" : ""}${hasFiles ? ", " + uploadedFileCount + " files" : ""}${hasWorkers ? ", " + workerTemplates.length + " workers" : ""}${hasCrons ? ", " + crons.length + " crons" : ""}
Chưa có: ${missing.join(", ")}
→ Khi phù hợp, CHỦ ĐỘNG đề xuất thêm: "${missing[0]}" để hệ thống hoàn thiện hơn`;
    }
  } catch {}

  // ── Fetch bot instructions from DB ──────────────────────
  let instructions = "";
  try {
    const db = (await import("../../db/connection.js")).getDb();
    const { tenants } = await import("../../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const tenant = (await db.select({ instructions: tenants.instructions }).from(tenants).where(eq(tenants.id, ctx.tenantId)).limit(1))[0];
    instructions = tenant?.instructions ?? "";
  } catch {}

  // ── Build final system prompt ───────────────────────────
  ctx.systemPrompt = buildCommanderPrompt(ctx.tenantName, ctx.userName, ctx.userRole, ctx.aiConfig, instructions)
    + ctx.knowledgeContext + ctx.fileContext + ctx.formContext + ctx.onboardingContext;
}
