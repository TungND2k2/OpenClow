import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb } from "./connection.js";

/**
 * Run all pending Drizzle migrations.
 * Called once at startup before any services initialize.
 */
export async function runMigrations(): Promise<void> {
  const db = getDb();
  await migrate(db, { migrationsFolder: "./drizzle" });
}
