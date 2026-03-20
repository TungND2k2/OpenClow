import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createMcpServer } from "./mcp/server.js";
import { startOrchestrator, stopOrchestrator } from "./modules/orchestration/orchestrator.service.js";
import { startProxy, stopProxy } from "./proxy/proxy.service.js";
import { startTelegramBot, stopTelegramBot } from "./bot/telegram.bot.js";
import { initAgentPool } from "./modules/agents/agent-pool.js";
import { executeTool } from "./bot/agent-bridge.js";

async function main() {
  // 1. Load config
  const config = loadConfig();
  console.error(`[OpenClaw] Starting (env=${config.NODE_ENV})`);

  // 2. Run migrations
  runMigrations();
  console.error("[OpenClaw] Database ready");

  // 3. Initialize Agent Pool (Commander + Workers in DB)
  const pool = await initAgentPool({
    workerCount: 3,
    toolExecutor: executeTool,
  });
  console.error(`[OpenClaw] Agent pool ready`);

  // 4. Create MCP server
  const server = createMcpServer();
  console.error("[OpenClaw] MCP server created (66 tools, 3 resources)");

  // 5. Start orchestrator tick loop
  startOrchestrator();

  // 5. Start LLM proxy (if configured)
  startProxy();

  // 6. Start Telegram bot (if configured)
  await startTelegramBot();

  // 7. Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[OpenClaw] Stdio transport connected — ready!");

  // Graceful shutdown
  const shutdown = () => {
    console.error("[OpenClaw] Shutting down...");
    stopTelegramBot();
    stopOrchestrator();
    stopProxy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[OpenClaw] Fatal:", err);
  process.exit(1);
});
