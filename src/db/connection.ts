import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getConfig } from "../config.js";

let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (!_db) {
    const config = getConfig();
    const client = postgres(config.DATABASE_URL);
    _db = drizzle(client);
  }
  return _db;
}

export function closeDb() {
  _db = null;
}
