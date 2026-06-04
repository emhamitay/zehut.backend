import { Elysia, t } from "elysia";
import { commitContacts } from "./service";
import { CommitInputSchema, CommitResultSchema } from "../lib/schemas";
import type { AuthService } from "../auth/service";
import { requireAuth } from "../auth/guard";

export function personsRoutes(auth: AuthService) {
  return new Elysia({ prefix: "/api/persons" })
    .onBeforeHandle(requireAuth(auth))
    .post(
      "/commit",
      async ({ body, set }) => {
        try {
          const result = await commitContacts(body.contacts, body.sourceFile ?? null);
          console.log(
            `[commit] inserted=${result.inserted.length} ignored=${result.ignored} phoneAdded=${result.phoneAdded.length} alerts=${result.alerts.length}`
          );
          return result;
        } catch (e) {
          const message = (e as Error).message;
          console.error(`[commit] failed: ${message}`);
          set.status = 500;
          return { error: "commit_failed", message };
        }
      },
      {
        body: CommitInputSchema,
        response: {
          200: CommitResultSchema,
          401: t.Object({ error: t.String() }),
          500: t.Object({ error: t.String(), message: t.String() }),
        },
      }
    );
}
