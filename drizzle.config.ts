import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/db/schemas/*",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://openclaw:openclaw123@localhost:5432/openclaw",
  },
});
