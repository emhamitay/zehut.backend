import { defineConfig } from "drizzle-kit";

// drizzle-kit runs in a Node context, so load env files explicitly.
const loadEnvFile = (process as { loadEnvFile?: (path: string) => void })
  .loadEnvFile;

for (const file of [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
]) {
  try {
    loadEnvFile?.(file);
  } catch {
    // Ignore missing env files.
  }
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for drizzle-kit.");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
