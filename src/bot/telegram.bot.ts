/**
 * Telegram Bot — TRANSPORT LAYER with MESSAGE QUEUE.
 *
 * Flow:
 *   Poll updates → enqueue jobs → workers process concurrently → send responses
 *
 * No blocking. No hardcoded intents. Commander decides everything.
 */

import "dotenv/config";
import { eq, and } from "drizzle-orm";
import { getConfig } from "../config.js";
import { processWithCommander, type CommanderResponse } from "./agent-bridge.js";
import { MessageQueue, type QueueJob } from "./message-queue.js";
import { getOrCreateSession, appendMessage } from "../modules/conversations/conversation.service.js";
import { listFiles } from "../modules/storage/s3.service.js";
import { getTenant } from "../modules/tenants/tenant.service.js";
import { getDb } from "../db/connection.js";
import { tenantUsers } from "../db/schema.js";
import { newId } from "../utils/id.js";
import { downloadAndUpload } from "../modules/storage/s3.service.js";

const TELEGRAM_API = "https://api.telegram.org/bot";
let _running = false;
let _offset = 0;
let _queue: MessageQueue;

// ── Telegram API ─────────────────────────────────────────────

async function callTelegram(method: string, params: Record<string, unknown>): Promise<any> {
  const token = getConfig().TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("No bot token");
  const res = await fetch(`${TELEGRAM_API}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json() as { ok: boolean; result?: any; description?: string };
  if (!body.ok) throw new Error(`Telegram: ${body.description}`);
  return body.result;
}

async function sendTelegramMessage(chatId: string | number, text: string): Promise<number | undefined> {
  const chunks = splitMessage(text, 4000);
  let lastMsgId: number | undefined;
  for (const chunk of chunks) {
    try {
      const result = await callTelegram("sendMessage", { chat_id: chatId, text: chunk, parse_mode: "HTML" });
      lastMsgId = result?.message_id;
    } catch {
      const result = await callTelegram("sendMessage", { chat_id: chatId, text: chunk.replace(/<[^>]*>/g, "") });
      lastMsgId = result?.message_id;
    }
  }
  return lastMsgId;
}

async function editTelegramMessage(chatId: string | number, messageId: number, text: string): Promise<void> {
  try {
    await callTelegram("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" });
  } catch {
    try {
      await callTelegram("editMessageText", { chat_id: chatId, message_id: messageId, text: text.replace(/<[^>]*>/g, "") });
    } catch {}
  }
}

async function sendTelegramFile(chatId: string | number, fileUrl: string, fileName: string, caption?: string): Promise<void> {
  try {
    const mimeType = fileName.toLowerCase();
    if (mimeType.match(/\.(jpg|jpeg|png|gif|webp)$/)) {
      await callTelegram("sendPhoto", { chat_id: chatId, photo: fileUrl, caption });
    } else if (mimeType.match(/\.(mp4|mov|avi)$/)) {
      await callTelegram("sendVideo", { chat_id: chatId, video: fileUrl, caption });
    } else {
      await callTelegram("sendDocument", { chat_id: chatId, document: fileUrl, caption });
    }
  } catch (e: any) {
    // Fallback: send URL as text
    await sendTelegramMessage(chatId, `📎 <a href="${fileUrl}">${fileName}</a>${caption ? "\n" + caption : ""}`);
  }
}

/**
 * Send "typing..." indicator to Telegram chat.
 */
async function sendTyping(chatId: string | number): Promise<void> {
  try {
    const token = getConfig().TELEGRAM_BOT_TOKEN;
    if (!token) return;
    await fetch(`${TELEGRAM_API}${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

/**
 * Convert markdown to Telegram HTML.
 */
function markdownToTelegramHtml(text: string): string {
  let r = text;
  // Tables → plain text (Telegram doesn't support tables)
  r = r.replace(/\|[^\n]+\|/g, (line) => {
    return line.replace(/\|/g, " ").replace(/[-:]+/g, "").trim();
  });
  // Code blocks
  r = r.replace(/```[\w]*\n?([\s\S]*?)```/g, "<pre>$1</pre>");
  // Inline code
  r = r.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Bold **text**
  r = r.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // Italic *text* (not inside bold)
  r = r.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>");
  // Headers ## → bold
  r = r.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");
  // Blockquotes > text
  r = r.replace(/^>\s*(.+)$/gm, "│ <i>$1</i>");
  // Horizontal rules ---
  r = r.replace(/^-{3,}$/gm, "───────────");
  // List items - → •
  r = r.replace(/^-\s+/gm, "• ");
  // Clean excessive newlines
  r = r.replace(/\n{3,}/g, "\n\n").trim();
  return r;
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { parts.push(remaining); break; }
    let split = remaining.lastIndexOf("\n", maxLen);
    if (split < maxLen / 2) split = maxLen;
    parts.push(remaining.substring(0, split));
    remaining = remaining.substring(split).trimStart();
  }
  return parts;
}

// ── User role from DB ────────────────────────────────────────

interface UserInfo {
  role: string | null;
  displayName: string | null;
}

async function getUserInfo(telegramUserId: string, tenantId: string): Promise<UserInfo> {
  const db = getDb();
  const row = (await db.select({ role: tenantUsers.role, displayName: tenantUsers.displayName })
    .from(tenantUsers)
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.channel, "telegram"),
      eq(tenantUsers.channelUserId, telegramUserId),
      eq(tenantUsers.isActive, true),
    )).limit(1))[0];
  return { role: row?.role ?? null, displayName: row?.displayName ?? null };
}

// ── Registration flow state (in-memory per user) ────────────

interface RegistrationState {
  step: "name" | "phone" | "position" | "confirm";
  fullName?: string;
  phone?: string;
  position?: string;
  telegramName: string;
  telegramUsername?: string;
}

const _registrations = new Map<string, RegistrationState>(); // key: `${tenantId}:${userId}`

/** Create pending registration (isActive=false) → admin must approve */
async function createPendingUser(
  telegramUserId: string, tenantId: string,
  data: { fullName: string; phone: string; position: string; telegramName: string; telegramUsername?: string }
): Promise<string> {
  const db = getDb();
  const existing = (await db.select({ id: tenantUsers.id }).from(tenantUsers)
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.channel, "telegram"),
      eq(tenantUsers.channelUserId, telegramUserId),
    )).limit(1))[0];

  const meta = JSON.stringify({ phone: data.phone, position: data.position, telegramUsername: data.telegramUsername });
  const id = existing?.id ?? newId();

  if (existing) {
    await db.update(tenantUsers).set({
      displayName: data.fullName, isActive: false, updatedAt: Date.now(),
      metadata: meta,
    }).where(eq(tenantUsers.id, id));
  } else {
    await db.insert(tenantUsers).values({
      id, tenantId, channel: "telegram", channelUserId: telegramUserId,
      displayName: data.fullName, role: "user", isActive: false,
      metadata: meta, createdAt: Date.now(), updatedAt: Date.now(),
    });
  }
  return id;
}

/** Get all admin/manager chat IDs for notifications */
async function getAdminChatIds(tenantId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db.select({ channelUserId: tenantUsers.channelUserId, role: tenantUsers.role })
    .from(tenantUsers)
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.channel, "telegram"),
      eq(tenantUsers.isActive, true),
    ));
  return rows
    .filter(r => r.role === "admin" || r.role === "manager")
    .map(r => r.channelUserId);
}

/** Approve pending user */
async function approveUser(tenantId: string, channelUserId: string): Promise<boolean> {
  const db = getDb();
  const result = await db.update(tenantUsers).set({ isActive: true, updatedAt: Date.now() })
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.channel, "telegram"),
      eq(tenantUsers.channelUserId, channelUserId),
    )).returning({ id: tenantUsers.id });
  return result.length > 0;
}

/** Reject pending user */
async function rejectUser(tenantId: string, channelUserId: string): Promise<boolean> {
  const db = getDb();
  const result = await db.delete(tenantUsers)
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.channel, "telegram"),
      eq(tenantUsers.channelUserId, channelUserId),
      eq(tenantUsers.isActive, false),
    )).returning({ id: tenantUsers.id });
  return result.length > 0;
}

/** List pending registrations */
async function getPendingUsers(tenantId: string): Promise<any[]> {
  const db = getDb();
  return await db.select().from(tenantUsers)
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.isActive, false),
    ));
}

/** Update display name if changed (Telegram name can change anytime) */
async function syncUserName(telegramUserId: string, tenantId: string, newName: string): Promise<void> {
  const db = getDb();
  await db.update(tenantUsers)
    .set({ displayName: newName, updatedAt: Date.now() })
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.channel, "telegram"),
      eq(tenantUsers.channelUserId, telegramUserId),
    ));
}

// ── Job handler — processes one message through Commander ─────

async function handleJob(job: QueueJob): Promise<void> {
  const tenant = await getTenant(job.tenantId);

  const session = await getOrCreateSession({
    tenantId: job.tenantId,
    channel: "telegram",
    channelUserId: job.userId,
    userName: job.userName,
    userRole: job.userRole,
  });

  await appendMessage(session.id, { role: "user", content: job.text, at: Date.now() });

  // ── Send progress message immediately ──
  const progressMsgId = await sendTelegramMessage(job.chatId, "⏳ Đang xử lý...");

  const state = session.state ?? { messages: [] };
  const history = (state.messages ?? []).map((m: any) => ({
    role: m.role as string,
    content: m.content as string,
  }));

  // Progress callback — edits the progress message as tools execute
  const onProgress = async (stage: string) => {
    if (progressMsgId) {
      await editTelegramMessage(job.chatId, progressMsgId, stage);
    }
  };

  const response = await processWithCommander({
    userMessage: job.text,
    userName: job.userName,
    userId: job.userId,
    userRole: job.userRole,
    tenantId: job.tenantId,
    tenantName: tenant?.name ?? "OpenClaw",
    conversationHistory: history.slice(-15),
    aiConfig: (tenant?.aiConfig ?? {}) as Record<string, unknown>,
    onProgress,
  });

  // ── Edit progress message → final response ──
  const formattedText = markdownToTelegramHtml(response.text);
  await appendMessage(session.id, { role: "assistant", content: response.text, at: Date.now() });

  if (progressMsgId && formattedText.length <= 4000) {
    // Edit the progress message with final result
    await editTelegramMessage(job.chatId, progressMsgId, formattedText);
  } else {
    // Too long — delete progress, send new
    if (progressMsgId) {
      try { await callTelegram("deleteMessage", { chat_id: job.chatId, message_id: progressMsgId }); } catch {}
    }
    await sendTelegramMessage(job.chatId, formattedText);
  }

  // Send files from tool calls
  for (const file of response.files) {
    await sendTelegramFile(job.chatId, file.url, file.fileName);
  }

  // Auto-send uploaded images mentioned in response
  // Instead of relying on LLM-generated URLs (often malformed),
  // check if response mentions any uploaded file names → send from S3
  const uploadedFiles = await listFiles(job.tenantId, 20);
  for (const file of uploadedFiles) {
    const fname = (file as any).fileName?.toLowerCase() ?? "";
    const responseText = response.text.toLowerCase();
    const isImage = /\.(jpg|jpeg|png|gif|webp)$/.test(fname);
    // If response mentions this file (by name or "ảnh" + file context) → send it
    const nameWithoutExt = fname.replace(/\.[^.]+$/, "").replace(/_/g, " ");
    if (isImage && (responseText.includes(nameWithoutExt) || responseText.includes(fname) || responseText.includes((file as any).s3Url))) {
      try {
        await callTelegram("sendPhoto", { chat_id: job.chatId, photo: (file as any).s3Url });
      } catch {}
    }
  }
}

// ── Poll loop — lightweight, just enqueues ───────────────────

async function pollLoop(): Promise<void> {
  const config = getConfig();
  const tenantId = config.TELEGRAM_DEFAULT_TENANT_ID!;

  while (_running) {
    try {
      const updates = await callTelegram("getUpdates", {
        offset: _offset, timeout: 30, allowed_updates: ["message"],
      });

      for (const update of updates ?? []) {
        _offset = update.update_id + 1;
        const msg = update.message;
        if (!msg) continue;

        const userId = String(msg.from.id);
        const telegramName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || msg.from.username || "User";
        const userInfo = await getUserInfo(userId, tenantId);
        const userRole = userInfo.role;
        const userName = userInfo.displayName ?? telegramName;

        // Sync Telegram name to DB (if registered)
        if (userRole && userInfo.displayName !== telegramName) {
          await syncUserName(userId, tenantId, telegramName);
        }

        // ── Registration flow (multi-step) ──
        const regKey = `${tenantId}:${userId}`;
        const regState = _registrations.get(regKey);
        if (regState && msg.text) {
          const text = msg.text.trim();
          if (text === "/cancel") {
            _registrations.delete(regKey);
            await sendTelegramMessage(msg.chat.id, "❌ Đã huỷ đăng ký.");
            continue;
          }

          if (regState.step === "name") {
            regState.fullName = text;
            regState.step = "phone";
            await sendTelegramMessage(msg.chat.id, "📱 Nhập <b>số điện thoại</b> của bạn:");
          } else if (regState.step === "phone") {
            regState.phone = text;
            regState.step = "position";
            await sendTelegramMessage(msg.chat.id, "💼 Nhập <b>vị trí / chức vụ</b> của bạn (VD: Sale, Marketing, Kế toán...):");
          } else if (regState.step === "position") {
            regState.position = text;
            regState.step = "confirm";
            await sendTelegramMessage(msg.chat.id,
              `📋 <b>Xác nhận thông tin đăng ký:</b>\n\n` +
              `👤 Họ tên: <b>${regState.fullName}</b>\n` +
              `📱 SĐT: <b>${regState.phone}</b>\n` +
              `💼 Vị trí: <b>${regState.position}</b>\n\n` +
              `Gõ <b>OK</b> để gửi, hoặc /cancel để huỷ.`
            );
          } else if (regState.step === "confirm") {
            if (text.toLowerCase() === "ok" || text.toLowerCase() === "xác nhận") {
              // Save pending user
              await createPendingUser(userId, tenantId, {
                fullName: regState.fullName!,
                phone: regState.phone!,
                position: regState.position!,
                telegramName: regState.telegramName,
                telegramUsername: regState.telegramUsername,
              });
              _registrations.delete(regKey);

              await sendTelegramMessage(msg.chat.id,
                `✅ Đã gửi yêu cầu đăng ký!\n\nVui lòng chờ admin duyệt. Milo sẽ thông báo khi tài khoản được kích hoạt.`
              );

              // Notify all admins
              const adminIds = await getAdminChatIds(tenantId);
              for (const adminId of adminIds) {
                await sendTelegramMessage(adminId,
                  `🔔 <b>Yêu cầu đăng ký mới!</b>\n\n` +
                  `👤 ${regState.fullName}\n` +
                  `📱 ${regState.phone}\n` +
                  `💼 ${regState.position}\n` +
                  `🆔 Telegram: ${regState.telegramName} (@${regState.telegramUsername ?? "N/A"})\n\n` +
                  `Để duyệt, gõ: <code>/approve ${userId}</code>\n` +
                  `Để từ chối: <code>/reject ${userId}</code>`
                );
              }
              console.error(`[Bot] ${regState.fullName}(${userId}) registration pending — admins notified`);
            } else {
              await sendTelegramMessage(msg.chat.id, "Gõ <b>OK</b> để xác nhận, hoặc /cancel để huỷ.");
            }
          }
          continue;
        }

        // ── Access control ──
        if (!userRole) {
          if (msg.text?.trim() === "/start") {
            await sendTelegramMessage(msg.chat.id,
              `👋 Chào <b>${telegramName}</b>!\n\nMình là <b>Milo</b> — trợ lý AI.\n\nGõ /register để đăng ký sử dụng.`
            );
          } else if (msg.text?.trim() === "/register") {
            // Check if already pending or exists
            const existingUser = (await getDb().select({ isActive: tenantUsers.isActive }).from(tenantUsers)
              .where(and(
                eq(tenantUsers.tenantId, tenantId),
                eq(tenantUsers.channel, "telegram"),
                eq(tenantUsers.channelUserId, userId),
              )).limit(1))[0];

            if (existingUser && existingUser.isActive === false) {
              await sendTelegramMessage(msg.chat.id,
                `⏳ Bạn đã đăng ký rồi, đang chờ admin duyệt. Vui lòng đợi nhé!`
              );
            } else if (existingUser && existingUser.isActive === true) {
              await sendTelegramMessage(msg.chat.id,
                `✅ Bạn đã có tài khoản rồi! Hãy hỏi Milo bất kỳ điều gì.`
              );
            } else {
              _registrations.set(regKey, { step: "name", telegramName, telegramUsername: msg.from.username });
              await sendTelegramMessage(msg.chat.id,
                `📝 <b>Đăng ký sử dụng Milo</b>\n\n👤 Nhập <b>họ và tên</b> của bạn:`
              );
            }
          } else {
            console.error(`[Bot] ${telegramName}(${userId})[DENIED]: not registered`);
            await sendTelegramMessage(msg.chat.id,
              `⛔ Bạn chưa đăng ký.\n\nGõ /register để đăng ký, hoặc /start để xem hướng dẫn.`
            );
          }
          continue;
        }

        // ── Admin commands: /approve, /reject, /pending ──
        if ((userRole === "admin" || userRole === "manager") && msg.text) {
          const approveMatch = msg.text.match(/^\/approve\s+(\d+)$/);
          if (approveMatch) {
            const targetId = approveMatch[1];
            if (await approveUser(tenantId, targetId)) {
              await sendTelegramMessage(msg.chat.id, `✅ Đã duyệt user ${targetId}`);
              // Notify the approved user
              await sendTelegramMessage(targetId,
                `🎉 <b>Tài khoản đã được duyệt!</b>\n\nChào mừng bạn đến với Milo. Hãy hỏi mình bất kỳ điều gì!`
              );
            } else {
              await sendTelegramMessage(msg.chat.id, `❌ Không tìm thấy user ${targetId}`);
            }
            continue;
          }

          const rejectMatch = msg.text.match(/^\/reject\s+(\d+)$/);
          if (rejectMatch) {
            const targetId = rejectMatch[1];
            if (await rejectUser(tenantId, targetId)) {
              await sendTelegramMessage(msg.chat.id, `❌ Đã từ chối user ${targetId}`);
              await sendTelegramMessage(targetId,
                `😔 Yêu cầu đăng ký của bạn đã bị từ chối. Liên hệ admin nếu cần hỗ trợ.`
              );
            } else {
              await sendTelegramMessage(msg.chat.id, `Không tìm thấy user pending ${targetId}`);
            }
            continue;
          }

          if (msg.text.trim() === "/pending") {
            const pending = await getPendingUsers(tenantId);
            if (pending.length === 0) {
              await sendTelegramMessage(msg.chat.id, "📋 Không có yêu cầu đăng ký nào đang chờ duyệt.");
            } else {
              const list = pending.map((u: any) => {
                const meta = typeof u.metadata === "string" ? JSON.parse(u.metadata) : (u.metadata ?? {});
                return `• <b>${u.displayName}</b> — ${meta.position ?? "N/A"} — ${meta.phone ?? "N/A"}\n  /approve ${u.channelUserId}  |  /reject ${u.channelUserId}`;
              }).join("\n\n");
              await sendTelegramMessage(msg.chat.id, `📋 <b>Đang chờ duyệt (${pending.length}):</b>\n\n${list}`);
            }
            continue;
          }
        }

        // ── Handle file uploads ──
        const fileObj = msg.document ?? msg.photo?.at(-1) ?? msg.video ?? msg.audio ?? msg.voice;
        if (fileObj && getConfig().S3_BUCKET) {
          handleFileUpload(msg, fileObj, userId, userName, tenantId).catch(
            (e: any) => console.error(`[Bot] File upload error: ${e.message}`)
          );
          continue;
        }

        if (!msg.text) continue;

        const job: QueueJob = {
          id: newId(),
          chatId: msg.chat.id,
          userId,
          userName,
          userRole: userRole!,
          text: msg.text.trim(),
          tenantId,
          priority: userRole === "admin" ? 1 : userRole === "manager" ? 2 : 5,
          createdAt: Date.now(),
          retries: 0,
          maxRetries: 2,
        };

        console.error(`[Bot] ${userName}(${userId})[${userRole}]: ${job.text.substring(0, 60)}`);
        _queue.enqueue(job);
      }
    } catch (e: any) {
      if (!e.message?.includes("timeout")) {
        console.error("[Bot] Poll error:", e.message);
      }
    }
  }
}

// ── File upload handler ──────────────────────────────────────

const ALLOWED_MIME_PREFIXES = ["image/", "application/pdf", "text/", "application/vnd", "application/json", "application/octet-stream", "application/zip", "audio/", "video/"];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

async function handleFileUpload(
  msg: any,
  fileObj: any,
  userId: string,
  userName: string,
  tenantId: string
): Promise<void> {
  const chatId = msg.chat.id;
  const isPhoto = !!msg.photo;
  const fileId = fileObj.file_id;
  const fileSize = fileObj.file_size ?? 0;
  const fileName = fileObj.file_name ?? (isPhoto ? `photo_${Date.now()}.jpg` : `file_${Date.now()}`);
  const mimeType = fileObj.mime_type ?? (isPhoto ? "image/jpeg" : "application/octet-stream");

  // Size check
  if (fileSize > MAX_FILE_SIZE) {
    await sendTelegramMessage(chatId, `⚠️ File quá lớn (${(fileSize / 1024 / 1024).toFixed(1)}MB). Tối đa 20MB.`);
    return;
  }

  // Type check
  const allowed = ALLOWED_MIME_PREFIXES.some((p) => mimeType.startsWith(p));
  if (!allowed) {
    await sendTelegramMessage(chatId, `⚠️ Loại file không hỗ trợ: ${mimeType}`);
    return;
  }

  console.error(`[Bot] File from ${userName}: ${fileName} (${(fileSize / 1024).toFixed(1)}KB, ${mimeType})`);
  await sendTelegramMessage(chatId, `📤 Đang upload <b>${fileName}</b>...`);

  try {
    // Get file URL from Telegram
    const token = getConfig().TELEGRAM_BOT_TOKEN!;
    const fileInfo = await callTelegram("getFile", { file_id: fileId });
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

    // Download from Telegram → upload to S3
    const result = await downloadAndUpload({
      url: fileUrl,
      tenantId,
      fileName,
      mimeType,
      uploadedBy: userId,
      channel: "telegram",
    });

    const caption = msg.caption ?? "";
    const sizeStr = fileSize > 1024 * 1024
      ? `${(fileSize / 1024 / 1024).toFixed(1)}MB`
      : `${(fileSize / 1024).toFixed(1)}KB`;

    await sendTelegramMessage(chatId,
      `✅ <b>File đã lưu</b>\n` +
      `📎 ${fileName} (${sizeStr})\n` +
      `🔗 ID: <code>${result.id}</code>` +
      (caption ? `\n📝 ${caption}` : "")
    );

    // If has caption, process it as a message with file context
    if (caption) {
      const job: QueueJob = {
        id: newId(),
        chatId,
        userId,
        userName,
        userRole: (await getUserInfo(userId, tenantId)).role ?? "user",
        text: `[File uploaded: ${fileName} (${mimeType}, ${sizeStr}) → ID: ${result.id}] ${caption}`,
        tenantId,
        priority: 3,
        createdAt: Date.now(),
        retries: 0,
        maxRetries: 2,
      };
      _queue.enqueue(job);
    }
  } catch (e: any) {
    console.error(`[Bot] Upload failed: ${e.message}`);
    await sendTelegramMessage(chatId, `⚠️ Upload thất bại: ${e.message}`);
  }
}

// ── Start/Stop ───────────────────────────────────────────────

export async function startTelegramBot(): Promise<void> {
  const config = getConfig();
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_DEFAULT_TENANT_ID) {
    console.error("[TelegramBot] Missing token or tenant ID, skipping");
    return;
  }

  // Retry connection up to 5 times
  let me: any;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      me = await callTelegram("getMe", {});
      console.error(`[TelegramBot] @${me.username} (${me.first_name}) — ready`);
      break;
    } catch (e: any) {
      console.error(`[TelegramBot] Connect attempt ${attempt}/5 failed: ${e.message}`);
      if (attempt === 5) {
        console.error("[TelegramBot] Giving up, will retry via poll loop");
        me = { username: "unknown", first_name: "Bot" };
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }

  // Create queue with concurrency
  _queue = new MessageQueue(handleJob, {
    concurrency: 5,
    maxQueueSize: 100,
    jobTimeoutMs: 60000,
  });
  _queue.start();

  _running = true;
  pollLoop().catch((e) => console.error("[TelegramBot] Fatal:", e));
}

export function stopTelegramBot(): void {
  _running = false;
  _queue?.stop();
}

/**
 * Get queue metrics (exposed for monitoring dashboard).
 */
export function getQueueMetrics() {
  return _queue?.getMetrics() ?? null;
}
