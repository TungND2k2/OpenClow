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
// knowledge.service removed
import { initResourceCache } from "./modules/cache/resource-cache.js";
import { onEvent } from "./modules/events/event-bus.js";
import { handleEvent } from "./modules/events/event-handler.js";

async function main() {
  // 1. Load config
  const config = loadConfig();
  console.error(`[OpenClaw] Starting (env=${config.NODE_ENV})`);

  // 2. Run migrations
  await runMigrations();
  console.error("[OpenClaw] Database ready");

  // 3. Initialize Agent Pool (Commander + Workers in DB)
  await initAgentPool({
    toolExecutor: executeTool,
  });
  console.error(`[OpenClaw] Agent pool ready`);

  // 3b. Knowledge cleanup removed — using bot_docs

  // 3c. Build resource cache for all tenants
  await initResourceCache();

  // 3d. Wire event bus
  onEvent(handleEvent);

  // 4. Create MCP server
  const server = createMcpServer();
  console.error("[OpenClaw] MCP server created (66 tools, 3 resources)");

  // 5. Start orchestrator tick loop
  startOrchestrator();

  // 6. Start LLM proxy (if configured)
  startProxy();

  // 7. Start Telegram bot (if configured)
  await startTelegramBot();

  // 8. Start Dashboard API
  const { startDashboardAPI } = await import("./api/dashboard.js");
  startDashboardAPI(3102);

  // 9. Start stdio transport
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
