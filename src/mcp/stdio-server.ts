/**
 * MCP Stdio Server — entry point for Claude Agent SDK.
 * Same codebase, same DB, same tools. Just stdio transport.
 */
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { createMcpServer } from "./server.js";

async function main() {
  loadConfig();
  // Parent process (index.ts) chạy migrate trước khi spawn subprocess.
  // SKIP_MIGRATIONS=1 được set bởi agent-runner.ts khi tạo MCP subprocess.
  if (!process.env.SKIP_MIGRATIONS) {
    await runMigrations();
  }
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(() => process.exit(1));
