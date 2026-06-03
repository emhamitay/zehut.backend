import { eq, sql } from "drizzle-orm";
import { db as defaultDb, type Database } from "../db/client";
import { users, type UserRow } from "../db/schema";

export type UserRepo = ReturnType<typeof makeUserRepo>;

export function makeUserRepo(database: Database = defaultDb) {
  async function count(): Promise<number> {
    const [row] = await database
      .select({ n: sql<number>`count(*)::int` })
      .from(users);
    return row?.n ?? 0;
  }

  async function insert(input: {
    username: string;
    passwordHash: string;
  }): Promise<UserRow> {
    const [row] = await database
      .insert(users)
      .values({
        username: input.username,
        passwordHash: input.passwordHash,
      })
      .returning();
    return row;
  }

  async function findByUsername(username: string): Promise<UserRow | null> {
    const [row] = await database
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    return row ?? null;
  }

  async function findById(id: string): Promise<UserRow | null> {
    const [row] = await database
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row ?? null;
  }

  async function list(): Promise<UserRow[]> {
    return database.select().from(users);
  }

  async function deleteById(id: string): Promise<void> {
    await database.delete(users).where(eq(users.id, id));
  }

  return {
    count,
    insert,
    findByUsername,
    findById,
    list,
    delete: deleteById,
  };
}

export const userRepo = makeUserRepo();
