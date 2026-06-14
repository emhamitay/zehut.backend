import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb, type TestDb } from "../../../test/setup";
import { makeUserRepo } from "../../users/repo";
import { makeUserService } from "../../users/service";
import { makeAuthService } from "../../auth/service";
import { buildApp } from "../../app";
import { parseUseAi } from "../routes";

let tdb: TestDb;

beforeEach(async () => {
  tdb = await makeTestDb();
});

afterEach(async () => {
  await tdb.close();
});

function appFor(tdb: TestDb, useAi: boolean) {
  const users = makeUserService(makeUserRepo(tdb.db));
  const auth = makeAuthService({ secret: "test-secret" });
  return { app: buildApp({ users, auth, useAi }), users };
}

async function tokenFor(
  app: ReturnType<typeof buildApp>,
  users: ReturnType<typeof makeUserService>
): Promise<string> {
  await users.create({ username: "a", password: "secret-pass-123" });
  const res = await app.handle(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "a", password: "secret-pass-123" }),
    })
  );
  const data = (await res.json()) as { token: string };
  return data.token;
}

function extractRequest(token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost/api/extract", {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "excel", rows: [] }),
  });
}

describe("parseUseAi", () => {
  test("accepts true variants (case / whitespace insensitive)", () => {
    expect(parseUseAi({ USE_AI: "true" })).toBe(true);
    expect(parseUseAi({ USE_AI: " TRUE " })).toBe(true);
  });

  test("accepts false", () => {
    expect(parseUseAi({ USE_AI: "false" })).toBe(false);
    expect(parseUseAi({ USE_AI: "FALSE" })).toBe(false);
  });

  test("throws when unset (like DATABASE_URL)", () => {
    expect(() => parseUseAi({})).toThrow();
    expect(() => parseUseAi({ USE_AI: "" })).toThrow();
  });

  test("throws on non-boolean values", () => {
    expect(() => parseUseAi({ USE_AI: "yes" })).toThrow();
    expect(() => parseUseAi({ USE_AI: "1" })).toThrow();
  });
});

describe("POST /api/extract — USE_AI gate", () => {
  test("returns 503 ai_disabled when AI is off, without reaching OpenRouter", async () => {
    const { app, users } = appFor(tdb, false);
    const token = await tokenFor(app, users);
    const res = await app.handle(extractRequest(token));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "ai_disabled",
      message: expect.any(String),
    });
  });

  test("still requires auth (401) even when AI is off", async () => {
    const { app } = appFor(tdb, false);
    const res = await app.handle(extractRequest());
    expect(res.status).toBe(401);
  });
});
