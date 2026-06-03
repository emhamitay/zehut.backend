import { describe, expect, test } from "bun:test";
import { makeAuthService } from "../service";

describe("auth service tokens", () => {
  test("signToken + verifyToken round-trip returns the user id", async () => {
    const auth = makeAuthService({ secret: "test-secret" });
    const token = await auth.signToken({ sub: "user-123" });
    const payload = await auth.verifyToken(token);
    expect(payload?.sub).toBe("user-123");
  });

  test("verifyToken returns null on garbage", async () => {
    const auth = makeAuthService({ secret: "test-secret" });
    expect(await auth.verifyToken("not-a-token")).toBeNull();
  });

  test("verifyToken returns null when signed with different secret", async () => {
    const a = makeAuthService({ secret: "secret-a" });
    const b = makeAuthService({ secret: "secret-b" });
    const token = await a.signToken({ sub: "user-1" });
    expect(await b.verifyToken(token)).toBeNull();
  });
});
