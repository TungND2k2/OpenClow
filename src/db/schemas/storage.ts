import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

// ============================================================
// files — metadata for uploaded files (actual bytes in S3)
// ============================================================
export const files = pgTable(
  "files",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    fileName: text("file_name").notNull(),
    fileSize: integer("file_size").notNull(), // bytes
    mimeType: text("mime_type").notNull(),
    s3Key: text("s3_key").notNull(), // path in S3 bucket
    s3Url: text("s3_url"), // public or presigned URL
    uploadedBy: text("uploaded_by").notNull(), // channel_user_id
    channel: text("channel").notNull(), // telegram, web, etc.
    taskId: text("task_id"), // linked task if any
    workflowInstanceId: text("workflow_instance_id"), // linked workflow
    metadata: jsonb("metadata").default({}), // extracted text, dimensions, etc.
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_files_tenant").on(table.tenantId),
    index("idx_files_uploaded_by").on(table.uploadedBy),
    index("idx_files_task").on(table.taskId),
    index("idx_files_created").on(table.createdAt),
  ]
);
