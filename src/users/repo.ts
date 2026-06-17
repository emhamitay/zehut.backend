import { eq, or, sql } from "drizzle-orm";
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

  async function countActive(): Promise<number> {
    const [row] = await database
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.active, true));
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
    return database.select().from(users).where(eq(users.active, true));
  }

  // Usernames equal to `base` or of the form `base#<suffix>`. Used to pick the
  // next free suffix when deactivating. Escapes LIKE wildcards in `base` so a
  // username containing % or _ can't widen the match.
  async function findUsernamesByBase(base: string): Promise<string[]> {
    const escaped = base.replace(/([\\%_])/g, "\\$1");
    const rows = await database
      .select({ username: users.username })
      .from(users)
      .where(
        or(
          eq(users.username, base),
          sql`${users.username} like ${`${escaped}#%`} escape '\\'`
        )
      );
    return rows.map((r) => r.username);
  }

  async function deactivate(id: string, newUsername: string): Promise<UserRow> {
    const [row] = await database
      .update(users)
      .set({ active: false, deactivatedAt: new Date(), username: newUsername })
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  async function deleteById(id: string): Promise<void> {
    await database.delete(users).where(eq(users.id, id));
  }

  return {
    count,
    countActive,
    insert,
    findByUsername,
    findById,
    findUsernamesByBase,
    list,
    deactivate,
    delete: deleteById,
  };
}

export const userRepo = makeUserRepo();
