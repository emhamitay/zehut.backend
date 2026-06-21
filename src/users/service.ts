import type { UserRepo } from "./repo";
import type { UserRow } from "../db/schema";

export type PublicUser = {
  id: string;
  username: string;
  createdAt: Date;
};

export const MIN_PASSWORD_LENGTH = 8;

export type UserService = ReturnType<typeof makeUserService>;

function toPublic(u: UserRow): PublicUser {
  return { id: u.id, username: u.username, createdAt: u.createdAt };
}

function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export function makeUserService(repo: UserRepo) {
  async function create(input: {
    username: string;
    password: string;
  }): Promise<PublicUser> {
    const username = normalizeUsername(input.username);
    if (!username) throw new Error("username is required");
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `password must be at least ${MIN_PASSWORD_LENGTH} characters`
      );
    }
    const existing = await repo.findByUsername(username);
    if (existing) throw new Error("user already exists");
    const passwordHash = await Bun.password.hash(input.password);
    const row = await repo.insert({ username, passwordHash });
    return toPublic(row);
  }

  async function list(): Promise<PublicUser[]> {
    const rows = await repo.list();
    return rows.map(toPublic);
  }

  async function count(): Promise<number> {
    return repo.count();
  }

  async function findById(id: string): Promise<PublicUser | null> {
    const row = await repo.findById(id);
    return row ? toPublic(row) : null;
  }

  async function verifyCredentials(
    username: string,
    password: string
  ): Promise<PublicUser | null> {
    const row = await repo.findByUsername(normalizeUsername(username));
    if (!row) return null;
    // Deactivated accounts cannot log in, even with the renamed username#N.
    if (!row.active) return null;
    const ok = await Bun.password.verify(password, row.passwordHash);
    if (!ok) return null;
    return toPublic(row);
  }

  async function remove(id: string): Promise<void> {
    const target = await repo.findById(id);
    if (!target) throw new Error("user not found");
    // Removing an inactive user is always fine, but we must never leave the
    // system without an active user able to log in.
    if (target.active && (await repo.countActive()) <= 1) {
      throw new Error("cannot delete the last active user");
    }
    await repo.delete(id);
  }

  // Soft-disable: keep the account and the contact pages it created, but free
  // the username by renaming to `username#1` (`#2`, `#3`… if already taken) and
  // block login. The base username becomes available for a new user.
  async function deactivate(id: string): Promise<PublicUser> {
    const target = await repo.findById(id);
    if (!target) throw new Error("user not found");
    if (!target.active) throw new Error("user already inactive");
    if ((await repo.countActive()) <= 1) {
      throw new Error("cannot deactivate the last active user");
    }
    const base = target.username;
    const taken = new Set(await repo.findUsernamesByBase(base));
    let k = 1;
    while (taken.has(`${base}#${k}`)) k++;
    const row = await repo.deactivate(id, `${base}#${k}`);
    return toPublic(row);
  }

  return {
    create,
    list,
    count,
    findById,
    verifyCredentials,
    remove,
    deactivate,
  };
}
