// Set env vars required by transitive imports before any module loads them.
process.env.OPENROUTER_API_KEY ??= "test-key";
process.env.OPENROUTER_MODEL ??= "test-model";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../src/db/schema";
import type { Database } from "../src/db/client";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "drizzle");

export type TestDb = {
  db: Database;
  pg: PGlite;
  close: () => Promise<void>;
};

async function applyMigrations(pg: PGlite): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sqlText = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await pg.exec(stmt);
    }
  }
}

export async function makeTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.waitReady;
  await applyMigrations(pg);
  const db = drizzle(pg, { schema }) as unknown as Database;
  return {
    db,
    pg,
    close: async () => {
      await pg.close();
    },
  };
}
