import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb, type TestDb } from "../../../test/setup";
import { makeUserRepo } from "../../users/repo";
import { makeUserService } from "../../users/service";
import { makeAuthService } from "../service";
import { buildApp } from "../../app";

let tdb: TestDb;

beforeEach(async () => {
  tdb = await makeTestDb();
});

afterEach(async () => {
  await tdb.close();
});

function appFor(tdb: TestDb) {
  const users = makeUserService(makeUserRepo(tdb.db));
  const auth = makeAuthService({ secret: "test-secret" });
  return { app: buildApp({ users, auth }), users, auth };
}

async function loginAs(
  app: ReturnType<typeof buildApp>,
  username: string,
  password: string
): Promise<string> {
  const res = await app.handle(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { token: string };
  return data.token;
}

describe("auth routes", () => {
  test("GET /api/auth/setup-required returns true when 0 users", async () => {
    const { app } = appFor(tdb);
    const res = await app.handle(
      new Request("http://localhost/api/auth/setup-required")
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ required: true });
  });

  test("GET /api/auth/setup-required returns false once a user exists", async () => {
    const { app, users } = appFor(tdb);
    await users.create({ username: "a", password: "secret-pass-123" });
    const res = await app.handle(
      new Request("http://localhost/api/auth/setup-required")
    );
    expect(await res.json()).toEqual({ required: false });
  });

  test("POST /api/auth/login returns 401 on bad credentials", async () => {
    const { app, users } = appFor(tdb);
    await users.create({ username: "a", password: "secret-pass-123" });
    const res = await app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "a", password: "wrong" }),
      })
    );
    expect(res.status).toBe(401);
  });

  test("POST /api/auth/login returns a token on good credentials", async () => {
    const { app, users } = appFor(tdb);
    await users.create({ username: "a", password: "secret-pass-123" });
    const token = await loginAs(app, "a", "secret-pass-123");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
  });

  test("GET /api/auth/me returns 401 without token", async () => {
    const { app } = appFor(tdb);
    const res = await app.handle(
      new Request("http://localhost/api/auth/me")
    );
    expect(res.status).toBe(401);
  });

  test("GET /api/auth/me returns the user when authenticated", async () => {
    const { app, users } = appFor(tdb);
    await users.create({ username: "alice", password: "secret-pass-123" });
    const token = await loginAs(app, "alice", "secret-pass-123");
    const res = await app.handle(
      new Request("http://localhost/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { username: string };
    expect(data.username).toBe("alice");
  });
});

describe("users routes (protected)", () => {
  test("GET /api/users returns 401 without token", async () => {
    const { app } = appFor(tdb);
    const res = await app.handle(
      new Request("http://localhost/api/users")
    );
    expect(res.status).toBe(401);
  });

  test("GET /api/users returns the list when authenticated", async () => {
    const { app, users } = appFor(tdb);
    await users.create({ username: "alice", password: "secret-pass-123" });
    const token = await loginAs(app, "alice", "secret-pass-123");
    const res = await app.handle(
      new Request("http://localhost/api/users", {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{
      username: string;
      passwordHash?: string;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0].username).toBe("alice");
    expect(list[0].passwordHash).toBeUndefined();
  });

  test("POST /api/users creates a user when authenticated", async () => {
    const { app, users } = appFor(tdb);
    await users.create({ username: "alice", password: "secret-pass-123" });
    const token = await loginAs(app, "alice", "secret-pass-123");
    const res = await app.handle(
      new Request("http://localhost/api/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          username: "bob",
          password: "secret-pass-456",
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(await users.count()).toBe(2);
  });

  test("POST /api/users returns 400 on duplicate/invalid input", async () => {
    const { app, users } = appFor(tdb);
    await users.create({ username: "alice", password: "secret-pass-123" });
    const token = await loginAs(app, "alice", "secret-pass-123");
    const res = await app.handle(
      new Request("http://localhost/api/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          username: "alice",
          password: "secret-pass-456",
        }),
      })
    );
    expect(res.status).toBe(400);
  });

  test("DELETE /api/users/:id removes a non-last user", async () => {
    const { app, users } = appFor(tdb);
    await users.create({ username: "alice", password: "secret-pass-123" });
    const bob = await users.create({
      username: "bob",
      password: "secret-pass-456",
    });
    const token = await loginAs(app, "alice", "secret-pass-123");
    const res = await app.handle(
      new Request(`http://localhost/api/users/${bob.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    expect(res.status).toBe(200);
    expect(await users.count()).toBe(1);
  });

  test("DELETE /api/users/:id refuses to delete the last user", async () => {
    const { app, users } = appFor(tdb);
    const alice = await users.create({
      username: "alice",
      password: "secret-pass-123",
    });
    const token = await loginAs(app, "alice", "secret-pass-123");
    const res = await app.handle(
      new Request(`http://localhost/api/users/${alice.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    expect(res.status).toBe(400);
    expect(await users.count()).toBe(1);
  });
});

describe("POST /api/auth/setup", () => {
  test("creates the first user when no users exist and returns token + user", async () => {
    const { app, users } = appFor(tdb);
    expect(await users.count()).toBe(0);
    const res = await app.handle(
      new Request("http://localhost/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "super-secret-1",
        }),
      })
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      token: string;
      user: { username: string };
    };
    expect(typeof data.token).toBe("string");
    expect(data.user.username).toBe("admin");
    expect(await users.count()).toBe(1);
  });

  test("is forbidden once at least one user exists", async () => {
    const { app, users } = appFor(tdb);
    await users.create({ username: "alice", password: "secret-pass-123" });
    const res = await app.handle(
      new Request("http://localhost/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "intruder",
          password: "super-secret-1",
        }),
      })
    );
    expect(res.status).toBe(403);
    expect(await users.count()).toBe(1);
  });

  test("returns 400 on invalid input (short password)", async () => {
    const { app, users } = appFor(tdb);
    const res = await app.handle(
      new Request("http://localhost/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "short" }),
      })
    );
    expect(res.status).toBe(400);
    expect(await users.count()).toBe(0);
  });
});

describe("existing routes are protected", () => {
  test("POST /api/persons/commit returns 401 without token", async () => {
    const { app } = appFor(tdb);
    const res = await app.handle(
      new Request("http://localhost/api/persons/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contacts: [], sourceFile: null }),
      })
    );
    expect(res.status).toBe(401);
  });

  test("POST /api/extract returns 401 without token", async () => {
    const { app } = appFor(tdb);
    const res = await app.handle(
      new Request("http://localhost/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "docx", text: "x" }),
      })
    );
    expect(res.status).toBe(401);
  });
});
