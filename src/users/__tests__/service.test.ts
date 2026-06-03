import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb, type TestDb } from "../../../test/setup";
import { makeUserRepo } from "../repo";
import { makeUserService } from "../service";

let tdb: TestDb;

beforeEach(async () => {
  tdb = await makeTestDb();
});

afterEach(async () => {
  await tdb.close();
});

function service(tdb: TestDb) {
  return makeUserService(makeUserRepo(tdb.db));
}

describe("user service", () => {
  test("create hashes the password (hash !== plaintext)", async () => {
    const svc = service(tdb);
    const u = await svc.create({
      username: "alice",
      password: "secret-pass-123",
    });
    expect(u.username).toBe("alice");
    // never expose the hash
    expect((u as Record<string, unknown>).passwordHash).toBeUndefined();
    const found = await makeUserRepo(tdb.db).findByUsername("alice");
    expect(found?.passwordHash).toBeTruthy();
    expect(found?.passwordHash).not.toBe("secret-pass-123");
  });

  test("create lowercases and trims username", async () => {
    const svc = service(tdb);
    const u = await svc.create({
      username: "  Alice  ",
      password: "secret-pass-123",
    });
    expect(u.username).toBe("alice");
  });

  test("create rejects empty username", async () => {
    const svc = service(tdb);
    await expect(
      svc.create({ username: "  ", password: "secret-pass-123" })
    ).rejects.toThrow(/username/i);
  });

  test("create rejects short password", async () => {
    const svc = service(tdb);
    await expect(
      svc.create({ username: "alice", password: "short" })
    ).rejects.toThrow(/password/i);
  });

  test("create rejects duplicate username", async () => {
    const svc = service(tdb);
    await svc.create({ username: "alice", password: "secret-pass-123" });
    await expect(
      svc.create({ username: "ALICE", password: "another-pass-123" })
    ).rejects.toThrow(/exists/i);
  });

  test("list never exposes password hashes", async () => {
    const svc = service(tdb);
    await svc.create({ username: "alice", password: "secret-pass-123" });
    await svc.create({ username: "bob", password: "secret-pass-123" });
    const users = await svc.list();
    expect(users).toHaveLength(2);
    for (const u of users) {
      expect((u as Record<string, unknown>).passwordHash).toBeUndefined();
    }
  });

  test("verifyCredentials returns user on valid login", async () => {
    const svc = service(tdb);
    await svc.create({ username: "alice", password: "secret-pass-123" });
    const u = await svc.verifyCredentials("alice", "secret-pass-123");
    expect(u?.username).toBe("alice");
  });

  test("verifyCredentials returns null on wrong password", async () => {
    const svc = service(tdb);
    await svc.create({ username: "alice", password: "secret-pass-123" });
    expect(await svc.verifyCredentials("alice", "wrong-pass")).toBeNull();
  });

  test("verifyCredentials returns null on missing user", async () => {
    const svc = service(tdb);
    expect(await svc.verifyCredentials("nobody", "x")).toBeNull();
  });

  test("verifyCredentials is case-insensitive for username", async () => {
    const svc = service(tdb);
    await svc.create({ username: "alice", password: "secret-pass-123" });
    const u = await svc.verifyCredentials("ALICE", "secret-pass-123");
    expect(u?.username).toBe("alice");
  });

  test("remove deletes a user", async () => {
    const svc = service(tdb);
    const a = await svc.create({
      username: "alice",
      password: "secret-pass-123",
    });
    await svc.create({ username: "bob", password: "secret-pass-123" });
    await svc.remove(a.id);
    const users = await svc.list();
    expect(users.map((u) => u.username)).toEqual(["bob"]);
  });

  test("remove refuses to delete the last user", async () => {
    const svc = service(tdb);
    const a = await svc.create({
      username: "alice",
      password: "secret-pass-123",
    });
    await expect(svc.remove(a.id)).rejects.toThrow(/last user/i);
  });

  test("count returns user count", async () => {
    const svc = service(tdb);
    expect(await svc.count()).toBe(0);
    await svc.create({ username: "alice", password: "secret-pass-123" });
    expect(await svc.count()).toBe(1);
  });
});
