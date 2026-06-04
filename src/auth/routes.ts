import { Elysia, t } from "elysia";
import type { UserService } from "../users/service";
import type { AuthService } from "./service";
import { currentUserIdFromRequest } from "./guard";
import { CredentialsSchema } from "../lib/schemas";

export function authRoutes(users: UserService, auth: AuthService) {
  return new Elysia({ prefix: "/api/auth" })
    .get("/setup-required", async () => {
      const n = await users.count();
      return { required: n === 0 };
    })
    .post(
      "/setup",
      async ({ body, set }) => {
        const existing = await users.count();
        if (existing > 0) {
          set.status = 403;
          return { error: "setup_already_completed" };
        }
        try {
          const user = await users.create(body);
          const token = await auth.signToken({ sub: user.id });
          return { token, user };
        } catch (e) {
          set.status = 400;
          return { error: (e as Error).message };
        }
      },
      {
        body: CredentialsSchema,
      }
    )
    .post(
      "/login",
      async ({ body, set }) => {
        const user = await users.verifyCredentials(body.username, body.password);
        if (!user) {
          set.status = 401;
          return { error: "invalid_credentials" };
        }
        const token = await auth.signToken({ sub: user.id });
        return { token, user };
      },
      {
        body: CredentialsSchema,
      }
    )
    .get("/me", async ({ request, set }) => {
      const currentUserId = await currentUserIdFromRequest(auth, request);
      const user = currentUserId ? await users.findById(currentUserId) : null;
      if (!user) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      return user;
    });
}
