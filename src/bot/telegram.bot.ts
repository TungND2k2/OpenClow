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

async function sendTelegramMessage(chatId: string | number, text: string): Promise<void> {
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    try {
      await callTelegram("sendMessage", { chat_id: chatId, text: chunk, parse_mode: "HTML" });
    } catch {
      await callTelegram("sendMessage", { chat_id: chatId, text: chunk.replace(/<[^>]*>/g, "") });
    }
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

function getUserRole(telegramUserId: string, tenantId: string): string {
  const db = getDb();
  const row = db.select({ role: tenantUsers.role })
    .from(tenantUsers)
    .where(and(
      eq(tenantUsers.tenantId, tenantId),
      eq(tenantUsers.channel, "telegram"),
      eq(tenantUsers.channelUserId, telegramUserId),
      eq(tenantUsers.isActive, 1),
    )).get();
  return row?.role ?? "user";
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

  const state = session.state ?? { messages: [] };
  const history = (state.messages ?? []).map((m: any) => ({
    role: m.role as string,
    content: m.content as string,
  }));

  const response = await processWithCommander({
    userMessage: job.text,
    userName: job.userName,
    userId: job.userId,
    userRole: job.userRole,
    tenantId: job.tenantId,
    tenantName: tenant?.name ?? "OpenClaw",
    conversationHistory: history.slice(-15),
    aiConfig: (tenant?.aiConfig ?? {}) as Record<string, unknown>,
  });

  appendMessage(session.id, { role: "assistant", content: response.text, at: Date.now() });
  await sendTelegramMessage(job.chatId, response.text);

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
        const userName = msg.from.first_name ?? msg.from.username ?? "User";
        const userRole = getUserRole(userId, tenantId);

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
          userRole,
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
        userRole: getUserRole(userId, tenantId),
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
