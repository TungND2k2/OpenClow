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
import { processWithCommander } from "./agent-bridge.js";
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
let _queue: MessageQueue;

// ── Multi-bot state ──────────────────────────────────────────
interface BotInstance {
  tenantId: string;
  tenantName: string;
  token: string;
  username: string;
  offset: number;
}
const _bots = new Map<string, BotInstance>(); // tenantId → BotInstance

// ── Telegram API (token-based, not config-based) ─────────────

async function callTelegramWithToken(token: string, method: string, params: Record<string, unknown>): Promise<any> {
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

// Backward-compatible wrapper — uses first bot's token or config
async function callTelegram(method: string, params: Record<string, unknown>): Promise<any> {
  const token = getConfig().TELEGRAM_BOT_TOKEN ?? _bots.values().next().value?.token;
  if (!token) throw new Error("No bot token");
  return callTelegramWithToken(token, method, params);
}

async function sendTelegramMessage(chatId: string | number, text: string, token?: string): Promise<number | undefined> {
  const t = token ?? getConfig().TELEGRAM_BOT_TOKEN ?? _bots.values().next().value?.token;
  if (!t) return undefined;
  const chunks = splitMessage(text, 4000);
  let lastMsgId: number | undefined;
  for (const chunk of chunks) {
    try {
      const result = await callTelegramWithToken(t, "sendMessage", { chat_id: chatId, text: chunk, parse_mode: "HTML" });
      lastMsgId = result?.message_id;
    } catch {
      const result = await callTelegramWithToken(t, "sendMessage", { chat_id: chatId, text: chunk.replace(/<[^>]*>/g, "") });
      lastMsgId = result?.message_id;
    }
  }
  return lastMsgId;
}

async function editTelegramMessage(chatId: string | number, messageId: number, text: string, token?: string): Promise<void> {
  const t = token ?? getConfig().TELEGRAM_BOT_TOKEN ?? _bots.values().next().value?.token;
  if (!t) return;
  try {
    await callTelegramWithToken(t, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" });
  } catch {
    try {
      await callTelegramWithToken(t, "editMessageText", { chat_id: chatId, message_id: messageId, text: text.replace(/<[^>]*>/g, "") });
    } catch {}
  }
}

async function sendTelegramFile(chatId: string | number, fileUrl: string, fileName: string, caption?: string, token?: string): Promise<void> {
  const t = token ?? getConfig().TELEGRAM_BOT_TOKEN ?? _bots.values().next().value?.token;
  if (!t) return;
  try {
    const mimeType = fileName.toLowerCase();
    if (mimeType.match(/\.(jpg|jpeg|png|gif|webp)$/)) {
      await callTelegramWithToken(t, "sendPhoto", { chat_id: chatId, photo: fileUrl, caption });
    } else if (mimeType.match(/\.(mp4|mov|avi)$/)) {
      await callTelegramWithToken(t, "sendVideo", { chat_id: chatId, video: fileUrl, caption });
    } else {
      await callTelegramWithToken(t, "sendDocument", { chat_id: chatId, document: fileUrl, caption });
    }
  } catch {
    await sendTelegramMessage(chatId, `📎 <a href="${fileUrl}">${fileName}</a>${caption ? "\n" + caption : ""}`, t);
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

  // ── Auto-summarize if history too long ──
  try {
    const { autoSummarize } = await import("../modules/conversations/conversation.service.js");
    await autoSummarize(session.id, async (text: string) => {
      // Use fast API to summarize (cheap + fast)
      const { callFastAPI } = await import("../modules/agents/agent-runner.js");
      return await callFastAPI(
        "Tóm tắt ngắn gọn hội thoại sau (giữ lại tất cả data quan trọng: tên, số, ID, trạng thái):\n\n" + text,
        "Bạn là bot tóm tắt. Trả về 1 paragraph ngắn gọn.",
        [],
      );
    });
  } catch {}

  // ── Build optimized history (summary + recent + form state) ──
  const { buildOptimizedHistory } = await import("../modules/conversations/conversation.service.js");
  // Re-fetch session after potential summarization
  const freshSession = await getOrCreateSession({
    tenantId: job.tenantId, channel: "telegram",
    channelUserId: job.userId, userName: job.userName, userRole: job.userRole,
  });
  const { history } = buildOptimizedHistory(freshSession);

  // ── Send progress message immediately ──
  const tk = job.botToken;
  const progressMsgId = await sendTelegramMessage(job.chatId, "⏳ Đang xử lý...", tk);

  // Progress callback
  const onProgress = async (stage: string) => {
    if (progressMsgId) {
      await editTelegramMessage(job.chatId, progressMsgId, stage, tk);
    }
  };

  // Persona streaming — send each persona message immediately when ready
  let personaStreamed = false;
  const onPersonaMessage = async (pm: { emoji: string; name: string; content: string }) => {
    if (!personaStreamed && progressMsgId) {
      // Delete progress message on first persona message
      try { await callTelegramWithToken(tk, "deleteMessage", { chat_id: job.chatId, message_id: progressMsgId }); } catch {}
      personaStreamed = true;
    }
    // Unicode bold name + separator for visual prominence
    const boldName = pm.name.split("").map(c => {
      const code = c.charCodeAt(0);
      if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + code - 65); // 𝗔-𝗭
      if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + code - 97); // 𝗮-𝘇
      return c;
    }).join("");
    const formatted = markdownToTelegramHtml(`───────────────────\n${pm.emoji} ${boldName}\n───────────────────\n${pm.content}`);
    await sendTelegramMessage(job.chatId, formatted, tk);
  };

  const response = await processWithCommander({
    userMessage: job.text,
    userName: job.userName,
    userId: job.userId,
    userRole: job.userRole,
    tenantId: job.tenantId,
    tenantName: tenant?.name ?? "OpenClaw",
    conversationHistory: history,
    aiConfig: (tenant?.aiConfig ?? {}) as Record<string, unknown>,
    onProgress,
    onPersonaMessage,
    sessionId: session.id,
  });

  // ── Edit progress message → final response ──
  await appendMessage(session.id, { role: "assistant", content: response.text, at: Date.now() });

  // If personas already streamed, skip sending again
  if (personaStreamed) {
    // Already sent — do nothing
  } else {
    // Single response (normal flow)
    const formattedText = markdownToTelegramHtml(response.text);
    if (progressMsgId && formattedText.length <= 4000) {
      await editTelegramMessage(job.chatId, progressMsgId, formattedText, tk);
    } else {
      if (progressMsgId) {
        try { await callTelegramWithToken(tk, "deleteMessage", { chat_id: job.chatId, message_id: progressMsgId }); } catch {}
      }
      await sendTelegramMessage(job.chatId, formattedText, tk);
    }
  }

  // Send files from tool calls
  for (const file of response.files) {
    await sendTelegramFile(job.chatId, file.url, file.fileName, undefined, tk);
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
        await callTelegramWithToken(tk, "sendPhoto", { chat_id: job.chatId, photo: (file as any).s3Url });
      } catch {}
    }
  }
}

// ── Poll loop — lightweight, just enqueues ───────────────────

/**
 * Process a single Telegram update — handles registration, commands, messages.
 */
async function processUpdate(
  msg: any, userId: string, _userName: string, _userRole: string | null,
  tenantId: string, botToken: string,
): Promise<void> {
  // Helper — always send via the correct bot's token
  const send = (chatId: string | number, text: string) => sendTelegramMessage(chatId, text, botToken);
  {
        const telegramName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || msg.from.username || "User";
        const userInfo = await getUserInfo(userId, tenantId);
        const userRole = userInfo.role;
        const userName = userInfo.displayName ?? telegramName;

        // Get bot name from tenant config (not hardcoded)
        const tenant = await getTenant(tenantId);
        const aiCfg = (tenant?.aiConfig ?? {}) as any;
        const botName = aiCfg.bot_name ?? tenant?.name ?? "Bot";

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
            await send(msg.chat.id, "❌ Đã huỷ đăng ký.");
            return;
          }

          if (regState.step === "name") {
            regState.fullName = text;
            regState.step = "phone";
            await send(msg.chat.id, "📱 Nhập <b>số điện thoại</b> của bạn:");
          } else if (regState.step === "phone") {
            regState.phone = text;
            regState.step = "position";
            await send(msg.chat.id, "💼 Nhập <b>vị trí / chức vụ</b> của bạn (VD: Sale, Marketing, Kế toán...):");
          } else if (regState.step === "position") {
            regState.position = text;
            regState.step = "confirm";
            await send(msg.chat.id,
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

              await send(msg.chat.id,
                `✅ Đã gửi yêu cầu đăng ký!\n\nVui lòng chờ admin duyệt. ${botName} sẽ thông báo khi tài khoản được kích hoạt.`
              );

              // Notify all admins
              const adminIds = await getAdminChatIds(tenantId);
              for (const adminId of adminIds) {
                await send(adminId,
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
              await send(msg.chat.id, "Gõ <b>OK</b> để xác nhận, hoặc /cancel để huỷ.");
            }
          }
          return;
        }

        // ── Access control ──
        if (!userRole) {
          if (msg.text?.trim() === "/start") {
            await send(msg.chat.id,
              `👋 Chào <b>${telegramName}</b>!\n\nMình là <b>${botName}</b> — trợ lý AI.\n\nGõ /register để đăng ký sử dụng.`
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
              await send(msg.chat.id,
                `⏳ Bạn đã đăng ký rồi, đang chờ admin duyệt. Vui lòng đợi nhé!`
              );
            } else if (existingUser && existingUser.isActive === true) {
              await send(msg.chat.id,
                `✅ Bạn đã có tài khoản rồi! Hãy hỏi ${botName} bất kỳ điều gì.`
              );
            } else {
              _registrations.set(regKey, { step: "name", telegramName, telegramUsername: msg.from.username });
              await send(msg.chat.id,
                `📝 <b>Đăng ký sử dụng ${botName}</b>\n\n👤 Nhập <b>họ và tên</b> của bạn:`
              );
            }
          } else {
            console.error(`[Bot] ${telegramName}(${userId})[DENIED]: not registered`);
            await send(msg.chat.id,
              `⛔ Bạn chưa đăng ký.\n\nGõ /register để đăng ký, hoặc /start để xem hướng dẫn.`
            );
          }
          return;
        }

        // ── Admin commands: /approve, /reject, /pending ──
        if ((userRole === "admin" || userRole === "manager") && msg.text) {
          const approveMatch = msg.text.match(/^\/approve\s+(\d+)$/);
          if (approveMatch) {
            const targetId = approveMatch[1];
            if (await approveUser(tenantId, targetId)) {
              await send(msg.chat.id, `✅ Đã duyệt user ${targetId}`);
              // Notify the approved user
              await send(targetId,
                `🎉 <b>Tài khoản đã được duyệt!</b>\n\nChào mừng bạn! Hãy hỏi ${botName} bất kỳ điều gì.`
              );
            } else {
              await send(msg.chat.id, `❌ Không tìm thấy user ${targetId}`);
            }
            return;
          }

          const rejectMatch = msg.text.match(/^\/reject\s+(\d+)$/);
          if (rejectMatch) {
            const targetId = rejectMatch[1];
            if (await rejectUser(tenantId, targetId)) {
              await send(msg.chat.id, `❌ Đã từ chối user ${targetId}`);
              await send(targetId,
                `😔 Yêu cầu đăng ký của bạn đã bị từ chối. Liên hệ admin nếu cần hỗ trợ.`
              );
            } else {
              await send(msg.chat.id, `Không tìm thấy user pending ${targetId}`);
            }
            return;
          }

          if (msg.text.trim() === "/pending") {
            const pending = await getPendingUsers(tenantId);
            if (pending.length === 0) {
              await send(msg.chat.id, "📋 Không có yêu cầu đăng ký nào đang chờ duyệt.");
            } else {
              const list = pending.map((u: any) => {
                const meta = typeof u.metadata === "string" ? JSON.parse(u.metadata) : (u.metadata ?? {});
                return `• <b>${u.displayName}</b> — ${meta.position ?? "N/A"} — ${meta.phone ?? "N/A"}\n  /approve ${u.channelUserId}  |  /reject ${u.channelUserId}`;
              }).join("\n\n");
              await send(msg.chat.id, `📋 <b>Đang chờ duyệt (${pending.length}):</b>\n\n${list}`);
            }
            return;
          }

          // ── SSH confirm/cancel ──
          const confirmMatch = msg.text.match(/^\/confirm\s+(\S+)$/i);
          if (confirmMatch) {
            const { getPendingExec, deletePendingExec, executeSSH } = await import("../modules/ssh/ssh.service.js");
            const pending = getPendingExec(confirmMatch[1]);
            if (!pending) { await send(msg.chat.id, "❌ Không tìm thấy lệnh chờ hoặc đã hết hạn"); return; }
            if (pending.requestedBy !== userId) { await send(msg.chat.id, "❌ Chỉ người yêu cầu mới confirm được"); return; }
            deletePendingExec(confirmMatch[1]);
            await send(msg.chat.id, `⚡ Đang thực thi: <code>${pending.command}</code>`);
            const result = await executeSSH({ host: pending.host, port: pending.port, user: pending.user, command: pending.command });
            const output = result.stdout ? `<pre>${result.stdout.substring(0, 3000)}</pre>` : "(không có output)";
            await send(msg.chat.id, `✅ Hoàn thành (exit: ${result.exitCode})\n${output}${result.stderr ? `\n⚠️ ${result.stderr.substring(0, 500)}` : ""}`);
            return;
          }

          const cancelMatch = msg.text.match(/^\/cancel\s+(\S+)$/i);
          if (cancelMatch) {
            const { getPendingExec, deletePendingExec } = await import("../modules/ssh/ssh.service.js");
            const pending = getPendingExec(cancelMatch[1]);
            if (!pending) { await send(msg.chat.id, "❌ Không tìm thấy lệnh chờ"); return; }
            deletePendingExec(cancelMatch[1]);
            await send(msg.chat.id, `🚫 Đã huỷ lệnh: <code>${pending.command}</code>`);
            return;
          }

          // ── Permission commands: /grant, /deny, /revoke ──
          const { grantPermission: gp, revokePermission: rvk, resolvePermissionRequest: rpr, getPendingRequests: gpr } = await import("../modules/permissions/permission.service.js");

          // /grant <userId_or_name> <resource> <access>
          const grantMatch = msg.text.match(/^\/grant\s+(\S+)\s+(\S+)\s+(\S+)$/i);
          if (grantMatch) {
            let targetId = grantMatch[1];
            const resource = grantMatch[2];
            const access = grantMatch[3].toUpperCase();

            // Check: granter must have M (manage) permission on this resource
            const { checkPermission: cp } = await import("../modules/permissions/permission.service.js");
            const canManage = await cp(tenantId, userId, userRole, resource, "manage");
            if (!canManage.allowed) {
              await send(msg.chat.id, `⛔ Bạn không có quyền Manage trên <b>${resource}</b>. Không thể cấp quyền.`);
              return;
            }

            // Cannot grant more than own permissions (except admin)
            if (userRole !== "admin") {
              const ownPerm = await cp(tenantId, userId, userRole, resource, "create");
              for (const c of access) {
                if (c === "M") {
                  await send(msg.chat.id, `⛔ Chỉ Admin mới được cấp quyền Manage (M).`);
                  return;
                }
              }
            }

            // Resolve name to ID if needed
            if (!/^\d+$/.test(targetId)) {
              const _db = getDb();
              const allUsers = await _db.select({ channelUserId: tenantUsers.channelUserId, displayName: tenantUsers.displayName })
                .from(tenantUsers).where(eq(tenantUsers.tenantId, tenantId));
              const match = allUsers.find((u: any) => u.displayName?.toLowerCase().includes(targetId.toLowerCase()));
              if (match) targetId = match.channelUserId;
            }
            await gp(tenantId, targetId, resource, access);
            await send(msg.chat.id, `✅ Đã cấp quyền <b>${access}</b> trên <b>${resource}</b> cho user <b>${targetId}</b>`);
            // Notify the user
            try { await send(targetId, `🔓 Bạn đã được cấp quyền <b>${access}</b> trên <b>${resource}</b>`); } catch {}
            return;
          }

          // /deny <requestId>
          const denyMatch = msg.text.match(/^\/deny\s+(\S+)$/i);
          if (denyMatch) {
            await rpr(denyMatch[1], "rejected");
            await send(msg.chat.id, `❌ Đã từ chối yêu cầu quyền.`);
            return;
          }

          // /revoke <userId_or_name> <resource>
          const revokeMatch = msg.text.match(/^\/revoke\s+(\S+)\s+(\S+)$/i);
          if (revokeMatch) {
            let targetId = revokeMatch[1];
            const resource = revokeMatch[2];
            if (!/^\d+$/.test(targetId)) {
              const _db = getDb();
              const allUsers = await _db.select({ channelUserId: tenantUsers.channelUserId, displayName: tenantUsers.displayName })
                .from(tenantUsers).where(eq(tenantUsers.tenantId, tenantId));
              const match = allUsers.find((u: any) => u.displayName?.toLowerCase().includes(targetId.toLowerCase()));
              if (match) targetId = match.channelUserId;
            }
            await rvk(tenantId, targetId, resource);
            await send(msg.chat.id, `🔒 Đã thu hồi quyền trên <b>${resource}</b> của user <b>${targetId}</b>`);
            return;
          }

          // /permissions — xem pending permission requests
          if (msg.text.trim() === "/permissions") {
            const reqs = await gpr(userId);
            if (reqs.length === 0) {
              await send(msg.chat.id, "📋 Không có yêu cầu quyền nào đang chờ.");
            } else {
              const list = reqs.map((r: any) =>
                `• <b>${r.requesterName}</b> xin <b>${r.requestedAccess}</b> trên <b>${r.resource}</b>\n  <code>/grant ${r.requesterId} ${r.resource} ${r.requestedAccess}</code>  |  <code>/deny ${r.id}</code>`
              ).join("\n\n");
              await send(msg.chat.id, `🔐 <b>Yêu cầu quyền (${reqs.length}):</b>\n\n${list}`);
            }
            return;
          }
        }

        // ── Handle file uploads ──
        const fileObj = msg.document ?? msg.photo?.at(-1) ?? msg.video ?? msg.audio ?? msg.voice;
        if (fileObj && getConfig().S3_BUCKET) {
          handleFileUpload(msg, fileObj, userId, userName, tenantId, botToken).catch(
            (e: any) => console.error(`[Bot] File upload error: ${e.message}`)
          );
          return;
        }

        if (!msg.text) return;

        const bot = _bots.get(tenantId);
        const job: QueueJob = {
          id: newId(),
          chatId: msg.chat.id,
          userId,
          userName,
          userRole: userRole!,
          text: msg.text.trim(),
          tenantId,
          botToken: bot?.token ?? getConfig().TELEGRAM_BOT_TOKEN ?? "",
          priority: userRole === "admin" ? 1 : userRole === "manager" ? 2 : 5,
          createdAt: Date.now(),
          retries: 0,
          maxRetries: 2,
        };

        console.error(`[Bot:${bot?.tenantName ?? "?"}] ${userName}(${userId})[${userRole}]: ${job.text.substring(0, 60)}`);
        _queue.enqueue(job);
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
  tenantId: string,
  botToken?: string,
): Promise<void> {
  const chatId = msg.chat.id;
  const isPhoto = !!msg.photo;
  const fileId = fileObj.file_id;
  const fileSize = fileObj.file_size ?? 0;
  const fileName = fileObj.file_name ?? (isPhoto ? `photo_${Date.now()}.jpg` : `file_${Date.now()}`);
  const mimeType = fileObj.mime_type ?? (isPhoto ? "image/jpeg" : "application/octet-stream");

  const tk = botToken;

  // Size check
  if (fileSize > MAX_FILE_SIZE) {
    await sendTelegramMessage(chatId, `⚠️ File quá lớn (${(fileSize / 1024 / 1024).toFixed(1)}MB). Tối đa 20MB.`, tk);
    return;
  }

  // Type check
  const allowed = ALLOWED_MIME_PREFIXES.some((p) => mimeType.startsWith(p));
  if (!allowed) {
    await sendTelegramMessage(chatId, `⚠️ Loại file không hỗ trợ: ${mimeType}`, tk);
    return;
  }

  console.error(`[Bot] File from ${userName}: ${fileName} (${(fileSize / 1024).toFixed(1)}KB, ${mimeType})`);
  await sendTelegramMessage(chatId, `📤 Đang upload <b>${fileName}</b>...`, tk);

  try {
    // Get file URL from Telegram — find token for this tenant
    const bot = _bots.get(tenantId);
    const token = bot?.token ?? getConfig().TELEGRAM_BOT_TOKEN!;
    const fileInfo = await callTelegramWithToken(token, "getFile", { file_id: fileId });
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
      (caption ? `\n📝 ${caption}` : ""),
      tk,
    );

    // If has caption, process it as a message with file context
    if (caption) {
      const _bot = _bots.get(tenantId);
      const job: QueueJob = {
        id: newId(),
        chatId,
        userId,
        userName,
        userRole: (await getUserInfo(userId, tenantId)).role ?? "user",
        text: `[File uploaded: ${fileName} (${mimeType}, ${sizeStr}) → ID: ${result.id}] ${caption}`,
        tenantId,
        botToken: _bot?.token ?? getConfig().TELEGRAM_BOT_TOKEN ?? "",
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

/**
 * Start multi-bot polling — reads bots from DB + .env fallback.
 */
export async function startTelegramBot(): Promise<void> {
  const config = getConfig();
  const db = getDb();
  const { tenants: tenantsTable, superAdmins } = await import("../db/schema.js");

  // Create queue (shared across all bots)
  _queue = new MessageQueue(handleJob, {
    concurrency: 5,
    maxQueueSize: 100,
    jobTimeoutMs: 180000,
  });
  _queue.start();
  _running = true;

  // ── Load bots from DB ──
  const dbTenants = await db.select().from(tenantsTable)
    .where(eq(tenantsTable.botStatus, "active"));

  for (const t of dbTenants) {
    if (!t.botToken) continue;
    try {
      const me = await callTelegramWithToken(t.botToken, "getMe", {});
      const bot: BotInstance = {
        tenantId: t.id,
        tenantName: t.name,
        token: t.botToken,
        username: me.username,
        offset: 0,
      };
      _bots.set(t.id, bot);

      // Update bot_username in DB
      await db.update(tenantsTable).set({ botUsername: `@${me.username}` }).where(eq(tenantsTable.id, t.id));
      console.error(`[TelegramBot] @${me.username} (${t.name}) — ready`);
    } catch (e: any) {
      console.error(`[TelegramBot] ${t.name}: connect failed — ${e.message}`);
    }
  }

  // ── Fallback: .env bot (backward compatible) ──
  if (_bots.size === 0 && config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_DEFAULT_TENANT_ID) {
    try {
      const me = await callTelegramWithToken(config.TELEGRAM_BOT_TOKEN, "getMe", {});
      const tenant = await getTenant(config.TELEGRAM_DEFAULT_TENANT_ID);
      const bot: BotInstance = {
        tenantId: config.TELEGRAM_DEFAULT_TENANT_ID,
        tenantName: tenant?.name ?? "OpenClaw",
        token: config.TELEGRAM_BOT_TOKEN,
        username: me.username,
        offset: 0,
      };
      _bots.set(bot.tenantId, bot);

      // Save token to DB for future
      await db.update(tenantsTable).set({
        botToken: config.TELEGRAM_BOT_TOKEN,
        botUsername: `@${me.username}`,
        botStatus: "active",
      }).where(eq(tenantsTable.id, config.TELEGRAM_DEFAULT_TENANT_ID));

      console.error(`[TelegramBot] @${me.username} (${bot.tenantName}) — ready (from .env)`);
    } catch (e: any) {
      console.error(`[TelegramBot] .env bot connect failed: ${e.message}`);
    }
  }

  if (_bots.size === 0) {
    console.error("[TelegramBot] No bots configured");
    return;
  }

  // ── Start polling for all bots ──
  for (const bot of _bots.values()) {
    pollBotLoop(bot).catch((e) => console.error(`[TelegramBot] ${bot.tenantName} fatal:`, e));
  }
}

/**
 * Poll loop for a single bot.
 */
async function pollBotLoop(bot: BotInstance): Promise<void> {
  while (_running) {
    try {
      const updates = await callTelegramWithToken(bot.token, "getUpdates", {
        offset: bot.offset, timeout: 30, allowed_updates: ["message"],
      });

      for (const update of updates ?? []) {
        bot.offset = update.update_id + 1;
        const msg = update.message;
        if (!msg) continue;

        const userId = String(msg.from.id);
        const userName = msg.from.first_name ?? msg.from.username ?? "User";
        const { role: userRole } = await getUserInfo(userId, bot.tenantId);

        // Process message with this bot's tenantId
        await processUpdate(msg, userId, userName, userRole, bot.tenantId, bot.token);
      }
    } catch (e: any) {
      if (!e.message?.includes("timeout")) {
        console.error(`[Bot:${bot.tenantName}] Poll error: ${e.message}`);
      }
    }
  }
}

/**
 * Add a new bot at runtime (Super Admin creates bot via chat).
 */
export async function addBot(tenantId: string, token: string): Promise<string> {
  const me = await callTelegramWithToken(token, "getMe", {});
  const tenant = await getTenant(tenantId);
  const bot: BotInstance = {
    tenantId,
    tenantName: tenant?.name ?? "Bot",
    token,
    username: me.username,
    offset: 0,
  };
  _bots.set(tenantId, bot);

  // Save to DB
  const db = getDb();
  const { tenants: tenantsTable } = await import("../db/schema.js");
  await db.update(tenantsTable).set({
    botToken: token,
    botUsername: `@${me.username}`,
    botStatus: "active",
  }).where(eq(tenantsTable.id, tenantId));

  // Start polling
  pollBotLoop(bot).catch((e) => console.error(`[Bot:${bot.tenantName}] Fatal:`, e));
  console.error(`[TelegramBot] @${me.username} (${bot.tenantName}) — added + started`);
  return me.username;
}

/**
 * Stop a bot at runtime.
 */
export async function removeBot(tenantId: string): Promise<void> {
  _bots.delete(tenantId);
  const db = getDb();
  const { tenants: tenantsTable } = await import("../db/schema.js");
  await db.update(tenantsTable).set({ botStatus: "stopped" }).where(eq(tenantsTable.id, tenantId));
  console.error(`[TelegramBot] Bot for tenant ${tenantId} stopped`);
}

/**
 * List running bots.
 */
export function listBots(): { tenantId: string; tenantName: string; username: string }[] {
  return Array.from(_bots.values()).map(b => ({
    tenantId: b.tenantId,
    tenantName: b.tenantName,
    username: b.username,
  }));
}

export function stopTelegramBot(): void {
  _running = false;
  _queue?.stop();
}

export function getQueueMetrics() {
  return _queue?.getMetrics() ?? null;
}

/**
 * Send cron notification to a user via their tenant's bot.
 * Used by orchestrator when cron tasks fire.
 */
export async function sendCronNotification(tenantId: string, userId: string, message: string): Promise<void> {
  const bot = _bots.get(tenantId);
  if (!bot) return;
  try {
    await sendTelegramMessage(userId, message, bot.token);
  } catch (err: any) {
    console.error(`[Cron] Notification failed (${userId}): ${err.message}`);
  }
}
