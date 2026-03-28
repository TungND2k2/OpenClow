/**
 * User File Context — maps latest file per user for auto-reference.
 *
 * When user uploads file → analyze → store result
 * When user asks next question → inject file context automatically
 *
 * Memory only (not DB) — ephemeral, per session lifetime.
 */

export interface UserFileInfo {
  fileId: string;
  fileName: string;
  mimeType: string;
  isImage: boolean;
  analysis: string;       // extracted text / image description
  uploadedAt: number;
}

// key: tenantId:userId → latest file info
const userFileMap = new Map<string, UserFileInfo>();

function key(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

export function setUserFile(tenantId: string, userId: string, info: UserFileInfo): void {
  userFileMap.set(key(tenantId, userId), info);
  console.error(`[FileContext] ${userId} → ${info.fileName} (${info.analysis.length} chars analysis)`);
}

export function getUserFile(tenantId: string, userId: string): UserFileInfo | undefined {
  return userFileMap.get(key(tenantId, userId));
}

export function clearUserFile(tenantId: string, userId: string): void {
  userFileMap.delete(key(tenantId, userId));
}

/**
 * Build context string for injection into prompt.
 */
export function buildFileContextForUser(tenantId: string, userId: string): string {
  const file = getUserFile(tenantId, userId);
  if (!file) return "";

  // Only inject if recent (within 30 min)
  const age = Date.now() - file.uploadedAt;
  if (age > 30 * 60 * 1000) return "";

  return `\n\n[FILE VỪA GỬI BỞI USER — TỰ ĐỘNG DÙNG NẾU LIÊN QUAN]
File: ${file.fileName} (ID: ${file.fileId})
Loại: ${file.isImage ? "Ảnh" : "Tài liệu"} (${file.mimeType})
Nội dung phân tích:
${file.analysis.substring(0, 2000)}
→ DÙNG THÔNG TIN NÀY khi user hỏi liên quan. Nếu user vừa gửi file mà chưa nói gì → TÓM TẮT nội dung file cho user biết.`;
}
