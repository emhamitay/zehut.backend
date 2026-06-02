import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const DATABASE_URL =
  Bun.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/zehut";

const pool = new Pool({ connectionString: DATABASE_URL });

export const db = drizzle(pool, { schema });
export type DB = typeof db;
