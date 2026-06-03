import { drizzle } from "drizzle-orm/node-postgres";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema";

const DATABASE_URL =
  Bun.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/zehut";

const pool = new Pool({ connectionString: DATABASE_URL });

export const db = drizzle(pool, { schema });

export type Database = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
