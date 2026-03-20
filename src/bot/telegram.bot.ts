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

function getUserInfo(telegramUserId: string, tenantId: string): UserInfo {
  const db = getDb();
  const row = db.select({ role: tenantUsers.role, displayName: tenantUsers.displayName })
    .from(tenantUsers)
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.channel, "telegram"),
      eq(tenantUsers.channelUserId, telegramUserId),
      eq(tenantUsers.isActive, 1),
    )).get();
  return { role: row?.role ?? null, displayName: row?.displayName ?? null };
}

/** Auto-register new user with role "user" */
function autoRegisterUser(telegramUserId: string, tenantId: string, displayName: string, username?: string): void {
  const db = getDb();
  const existing = db.select({ id: tenantUsers.id }).from(tenantUsers)
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.channel, "telegram"),
      eq(tenantUsers.channelUserId, telegramUserId),
    )).get();

  if (existing) {
    // Re-activate if was deactivated
    db.update(tenantUsers).set({ isActive: 1, displayName, updatedAt: Date.now() })
      .where(eq(tenantUsers.id, existing.id)).run();
  } else {
    db.insert(tenantUsers).values({
      id: newId(), tenantId, channel: "telegram", channelUserId: telegramUserId,
      displayName, role: "user", isActive: 1, createdAt: Date.now(), updatedAt: Date.now(),
    }).run();
  }
}

/** Update display name if changed (Telegram name can change anytime) */
function syncUserName(telegramUserId: string, tenantId: string, newName: string): void {
  const db = getDb();
  db.update(tenantUsers)
    .set({ displayName: newName, updatedAt: Date.now() })
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.channel, "telegram"),
      eq(tenantUsers.channelUserId, telegramUserId),
    )).run();
}

// ── Job handler — processes one message through Commander ─────

async function handleJob(job: QueueJob): Promise<void> {
  const tenant = getTenant(job.tenantId);

  const session = getOrCreateSession({
    tenantId: job.tenantId,
    channel: "telegram",
    channelUserId: job.userId,
    userName: job.userName,
    userRole: job.userRole,
  });

  appendMessage(session.id, { role: "user", content: job.text, at: Date.now() });

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
  appendMessage(session.id, { role: "assistant", content: response.text, at: Date.now() });

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

  // Send files if any
  for (const file of response.files) {
    await sendTelegramFile(job.chatId, file.url, file.fileName);
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
        const userInfo = getUserInfo(userId, tenantId);
        const userRole = userInfo.role;
        const userName = userInfo.displayName ?? telegramName;

        // Sync Telegram name to DB (if registered)
        if (userRole && userInfo.displayName !== telegramName) {
          syncUserName(userId, tenantId, telegramName);
        }

        // ── Access control ──
        if (!userRole) {
          // Auto-register on /start, reject otherwise
          if (msg.text?.trim() === "/start") {
            autoRegisterUser(userId, tenantId, telegramName, msg.from.username);
            console.error(`[Bot] ${telegramName}(${userId}) auto-registered as user`);
            await sendTelegramMessage(msg.chat.id,
              `👋 Chào <b>${telegramName}</b>!\n\nMình là <b>Milo</b> — trợ lý AI. Bạn đã được đăng ký thành công.\n\nHãy hỏi mình bất kỳ điều gì!`
            );
          } else {
            console.error(`[Bot] ${telegramName}(${userId})[DENIED]: not registered`);
            await sendTelegramMessage(msg.chat.id,
              `⛔ Xin lỗi, bạn chưa đăng ký.\n\nGõ /start để bắt đầu sử dụng Milo.`
            );
          }
          continue;
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

const ALLOWED_MIME_PREFIXES = ["image/", "application/pdf", "text/", "application/vnd", "application/json", "audio/", "video/"];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

async function handleFileUpload(
  msg: any,
  fileObj: any,
  userId: string,
  userName: string,
  tenantId: string
): Promise<void> {
  const chatId = msg.chat.id;
  const fileId = fileObj.file_id;
  const fileSize = fileObj.file_size ?? 0;
  const fileName = fileObj.file_name ?? `file_${Date.now()}`;
  const mimeType = fileObj.mime_type ?? "application/octet-stream";

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
        userRole: getUserInfo(userId, tenantId).role ?? "user",
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
