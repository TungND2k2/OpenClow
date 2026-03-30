import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().default("./data/openclaw.db"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  ORCHESTRATOR_TICK_MS: z.coerce.number().int().positive().default(5000),
  HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  HTTP_PORT: z.coerce.number().int().positive().optional(),
  PROXY_PORT: z.coerce.number().int().positive().optional(),

  // Commander LLM
  COMMANDER_API_BASE: z.string().default("https://api.anthropic.com"),
  COMMANDER_API_KEY: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional().transform(v => v && v.length > 10 ? v : undefined),
  COMMANDER_MODEL: z.string().default("claude-sonnet-4-20250514"),

  // Worker LLM (cheap API)
  WORKER_API_BASE: z.string().optional(),
  WORKER_API_KEY: z.string().optional(),
  WORKER_MODEL: z.string().default("gpt-4o-mini"),

  // S3 Storage
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),

  // Telegram Bot
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_DEFAULT_TENANT_ID: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;
  _config = configSchema.parse(process.env);
  return _config;
}

export function getConfig(): Config {
  if (!_config) return loadConfig();
  return _config;
}
