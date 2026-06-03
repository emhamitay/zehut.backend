import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb, type TestDb } from "../../../test/setup";
import { makeUserRepo } from "../repo";

let tdb: TestDb;

beforeEach(async () => {
  tdb = await makeTestDb();
});

afterEach(async () => {
  await tdb.close();
});

describe("user repo", () => {
  test("count returns 0 on empty db", async () => {
    const repo = makeUserRepo(tdb.db);
    expect(await repo.count()).toBe(0);
  });

  test("insert creates a user and increments count", async () => {
    const repo = makeUserRepo(tdb.db);
    const user = await repo.insert({
      username: "alice",
      passwordHash: "hash:abc",
    });
    expect(user.id).toBeTruthy();
    expect(user.username).toBe("alice");
    expect(user.passwordHash).toBe("hash:abc");
    expect(await repo.count()).toBe(1);
  });

  test("findByUsername returns user with hash", async () => {
    const repo = makeUserRepo(tdb.db);
    await repo.insert({ username: "alice", passwordHash: "h" });
    const found = await repo.findByUsername("alice");
    expect(found?.username).toBe("alice");
    expect(found?.passwordHash).toBe("h");
  });

  test("findByUsername returns null when missing", async () => {
    const repo = makeUserRepo(tdb.db);
    expect(await repo.findByUsername("nobody")).toBeNull();
  });

  test("findById returns user or null", async () => {
    const repo = makeUserRepo(tdb.db);
    const u = await repo.insert({ username: "a", passwordHash: "h" });
    expect((await repo.findById(u.id))?.username).toBe("a");
    expect(
      await repo.findById("00000000-0000-0000-0000-000000000000")
    ).toBeNull();
  });

  test("list returns all users", async () => {
    const repo = makeUserRepo(tdb.db);
    await repo.insert({ username: "a", passwordHash: "h" });
    await repo.insert({ username: "b", passwordHash: "h" });
    const list = await repo.list();
    expect(list).toHaveLength(2);
    expect(list.map((u) => u.username).sort()).toEqual(["a", "b"]);
  });

  test("insert rejects duplicate username", async () => {
    const repo = makeUserRepo(tdb.db);
    await repo.insert({ username: "alice", passwordHash: "h" });
    await expect(
      repo.insert({ username: "alice", passwordHash: "h2" })
    ).rejects.toThrow();
  });

  test("delete removes the user", async () => {
    const repo = makeUserRepo(tdb.db);
    const u = await repo.insert({ username: "a", passwordHash: "h" });
    await repo.delete(u.id);
    expect(await repo.count()).toBe(0);
  });
});
