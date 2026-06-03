import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb, type TestDb } from "../../../test/setup";
import { makeUserRepo } from "../../users/repo";
import { makeUserService } from "../../users/service";
import { bootstrapAdmin } from "../bootstrap";

let tdb: TestDb;

beforeEach(async () => {
  tdb = await makeTestDb();
});

afterEach(async () => {
  await tdb.close();
});

function svc(tdb: TestDb) {
  return makeUserService(makeUserRepo(tdb.db));
}

describe("bootstrapAdmin", () => {
  test("creates admin when 0 users and env present", async () => {
    const users = svc(tdb);
    const created = await bootstrapAdmin(users, {
      username: "admin",
      password: "super-secret-1",
    });
    expect(created).toBe(true);
    expect(await users.count()).toBe(1);
    const ok = await users.verifyCredentials("admin", "super-secret-1");
    expect(ok?.username).toBe("admin");
  });

  test("no-ops when users already exist", async () => {
    const users = svc(tdb);
    await users.create({ username: "alice", password: "secret-pass-123" });
    const created = await bootstrapAdmin(users, {
      username: "admin",
      password: "super-secret-1",
    });
    expect(created).toBe(false);
    expect(await users.count()).toBe(1);
  });

  test("no-ops when env username missing", async () => {
    const users = svc(tdb);
    const created = await bootstrapAdmin(users, {
      username: undefined,
      password: "super-secret-1",
    });
    expect(created).toBe(false);
    expect(await users.count()).toBe(0);
  });

  test("no-ops when env password missing", async () => {
    const users = svc(tdb);
    const created = await bootstrapAdmin(users, {
      username: "admin",
      password: undefined,
    });
    expect(created).toBe(false);
    expect(await users.count()).toBe(0);
  });
});
