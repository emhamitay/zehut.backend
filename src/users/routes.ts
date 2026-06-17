import { Elysia, t } from "elysia";
import type { UserService } from "./service";
import type { AuthService } from "../auth/service";
import { requireAuth } from "../auth/guard";
import { CredentialsSchema } from "../lib/schemas";

export function usersRoutes(users: UserService, auth: AuthService) {
  return new Elysia({ prefix: "/api/users" })
    .onBeforeHandle(requireAuth(auth))
    .get("/", async () => {
      return users.list();
    })
    .post(
      "/",
      async ({ body, set }) => {
        try {
          return await users.create(body);
        } catch (e) {
          set.status = 400;
          return { error: (e as Error).message };
        }
      },
      {
        body: CredentialsSchema,
      }
    )
    .post("/:id/deactivate", async ({ params, set }) => {
      try {
        return { ok: true, user: await users.deactivate(params.id) };
      } catch (e) {
        set.status = 400;
        return { error: (e as Error).message };
      }
    })
    .delete("/:id", async ({ params, set }) => {
      try {
        await users.remove(params.id);
        return { ok: true };
      } catch (e) {
        set.status = 400;
        return { error: (e as Error).message };
      }
    });
}
