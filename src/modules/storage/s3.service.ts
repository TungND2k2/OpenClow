import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import mammoth from "mammoth";
import { eq } from "drizzle-orm";
import { getConfig } from "../../config.js";
import { getDb } from "../../db/connection.js";
import { files } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import { nowMs } from "../../utils/clock.js";
import { Readable } from "node:stream";

let _client: S3Client | null = null;

function getS3Client(): S3Client {
  if (_client) return _client;
  const config = getConfig();
  if (!config.S3_ENDPOINT || !config.S3_ACCESS_KEY || !config.S3_SECRET_KEY) {
    throw new Error("S3 not configured");
  }
  _client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
    forcePathStyle: true, // required for non-AWS S3
  });
  return _client;
}

/**
 * Generate S3 key path: openclaw/{tenant}/{YYYY-MM}/{id}.{ext}
 */
function generateS3Key(tenantId: string, fileName: string, fileId: string): string {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const ext = fileName.includes(".") ? fileName.split(".").pop() : "bin";
  return `openclaw/${tenantId}/${month}/${fileId}.${ext}`;
}

/**
 * Upload a file to S3 from a buffer or stream.
 */
export async function uploadFile(input: {
  tenantId: string;
  fileName: string;
  mimeType: string;
  body: Buffer | Readable;
  fileSize: number;
  uploadedBy: string;
  channel: string;
  taskId?: string;
  workflowInstanceId?: string;
}): Promise<{ id: string; s3Key: string; s3Url: string }> {
  const config = getConfig();
  const client = getS3Client();
  const id = newId();
  const s3Key = generateS3Key(input.tenantId, input.fileName, id);

  // Size check — 20MB max
  if (input.fileSize > 20 * 1024 * 1024) {
    throw new Error("File too large (max 20MB)");
  }

  console.error(`[S3] Uploading ${input.fileName} (${(input.fileSize / 1024).toFixed(1)}KB) → ${s3Key}`);

  await client.send(new PutObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: s3Key,
    Body: input.body,
    ContentType: input.mimeType,
    Metadata: {
      "tenant-id": input.tenantId,
      "uploaded-by": input.uploadedBy,
      "original-name": input.fileName,
    },
  }));

  const s3Url = `${config.S3_ENDPOINT}${config.S3_BUCKET}/${s3Key}`;

  // Save metadata to DB
  const db = getDb();
  await db.insert(files).values({
    id,
    tenantId: input.tenantId,
    fileName: input.fileName,
    fileSize: input.fileSize,
    mimeType: input.mimeType,
    s3Key,
    s3Url,
    uploadedBy: input.uploadedBy,
    channel: input.channel,
    taskId: input.taskId ?? null,
    workflowInstanceId: input.workflowInstanceId ?? null,
    createdAt: nowMs(),
  });

  console.error(`[S3] ✓ Uploaded: ${id} (${s3Key})`);
  return { id, s3Key, s3Url };
}

/**
 * Download a file from S3.
 */
export async function downloadFile(fileId: string): Promise<{
  body: Readable;
  fileName: string;
  mimeType: string;
  fileSize: number;
} | null> {
  const db = getDb();
  const file = (await db.select().from(files).where(eq(files.id, fileId)).limit(1))[0];
  if (!file) return null;

  const config = getConfig();
  const client = getS3Client();

  const response = await client.send(new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: file.s3Key,
  }));

  return {
    body: response.Body as Readable,
    fileName: file.fileName,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
  };
}

/**
 * Read file content as text. Supports: TXT, CSV, JSON, DOCX, PDF (basic).
 */
export async function readFileContent(fileId: string): Promise<{
  content: string;
  fileName: string;
  mimeType: string;
  truncated: boolean;
} | null> {
  const db = getDb();
  const file = (await db.select().from(files).where(eq(files.id, fileId)).limit(1))[0];
  if (!file) return null;

  const config = getConfig();
  const client = getS3Client();

  const response = await client.send(new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: file.s3Key,
  }));

  const bodyBytes = await response.Body?.transformToByteArray();
  if (!bodyBytes) return null;
  const buffer = Buffer.from(bodyBytes);

  let content = "";
  const mime = file.mimeType;

  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/csv") {
    content = buffer.toString("utf-8");
  } else if (mime.includes("wordprocessingml") || file.fileName.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer });
    content = result.value;
  } else if (mime === "application/pdf") {
    // Basic PDF text extraction — just look for text streams
    const text = buffer.toString("utf-8");
    const matches = text.match(/\(([^)]+)\)/g);
    content = matches ? matches.map(m => m.slice(1, -1)).join(" ") : "[PDF content — cannot extract text without pdf-parse library]";
  } else {
    content = `[Binary file: ${file.fileName} (${file.mimeType}, ${file.fileSize} bytes)]`;
  }

  // Truncate to ~4000 chars to fit in LLM context
  const MAX_LEN = 4000;
  const truncated = content.length > MAX_LEN;
  if (truncated) content = content.substring(0, MAX_LEN) + "\n\n... [truncated]";

  console.error(`[S3] Read content: ${file.fileName} (${content.length} chars${truncated ? ", truncated" : ""})`);

  return { content, fileName: file.fileName, mimeType: file.mimeType, truncated };
}

/**
 * Delete a file from S3 + DB.
 */
export async function deleteFile(fileId: string): Promise<boolean> {
  const db = getDb();
  const file = (await db.select().from(files).where(eq(files.id, fileId)).limit(1))[0];
  if (!file) return false;

  const config = getConfig();
  const client = getS3Client();

  await client.send(new DeleteObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: file.s3Key,
  }));

  await db.delete(files).where(eq(files.id, fileId));
  console.error(`[S3] Deleted: ${fileId} (${file.s3Key})`);
  return true;
}

/**
 * Get file metadata from DB.
 */
export async function getFile(fileId: string) {
  const db = getDb();
  return (await db.select().from(files).where(eq(files.id, fileId)).limit(1))[0] ?? null;
}

/**
 * List files for a tenant.
 */
export async function listFiles(tenantId: string, limit: number = 20) {
  const db = getDb();
  return await db.select()
    .from(files)
    .where(eq(files.tenantId, tenantId))
    .orderBy(files.createdAt)
    .limit(limit);
}

/**
 * Download file from URL (e.g., Telegram file URL) and upload to S3.
 */
export async function downloadAndUpload(input: {
  url: string;
  tenantId: string;
  fileName: string;
  mimeType: string;
  uploadedBy: string;
  channel: string;
}): Promise<{ id: string; s3Key: string; s3Url: string }> {
  const response = await fetch(input.url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());

  return uploadFile({
    ...input,
    body: buffer,
    fileSize: buffer.length,
  });
}
