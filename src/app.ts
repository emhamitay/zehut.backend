import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { extractContacts } from "./lib/openrouter";
import { commitContacts } from "./persons/service";
import {
  CommitInputSchema,
  CommitResultSchema,
  ContactSchema,
  ExtractInputSchema,
} from "./lib/schemas";
import type { UserService } from "./users/service";
import type { AuthService } from "./auth/service";

export type AppDeps = {
  users: UserService;
  auth: AuthService;
  corsOrigin?: RegExp | string;
};

const PUBLIC_PATHS = new Set<string>([
  "/",
  "/api/auth/setup-required",
  "/api/auth/login",
  "/api/auth/setup",
]);

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const [scheme, token] = h.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export function buildApp(deps: AppDeps) {
  const { users, auth } = deps;
  const corsOrigin = deps.corsOrigin ?? /^http:\/\/localhost(?::\d+)?$/;

  return new Elysia()
    .use(cors({ origin: corsOrigin }))
    .derive(async ({ request }) => {
      const token = bearerToken(request);
      if (!token) return { currentUserId: null as string | null };
      const payload = await auth.verifyToken(token);
      return { currentUserId: payload?.sub ?? null };
    })
    .onBeforeHandle(({ request, currentUserId, set }) => {
      const url = new URL(request.url);
      if (PUBLIC_PATHS.has(url.pathname)) return;
      if (!currentUserId) {
        set.status = 401;
        return { error: "unauthorized" };
      }
    })
    .get("/", () => "Hello Zehut Yehudit Server!")
    .get("/api/auth/setup-required", async () => {
      const n = await users.count();
      return { required: n === 0 };
    })
    .post(
      "/api/auth/setup",
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
        body: t.Object({ username: t.String(), password: t.String() }),
      }
    )
    .post(
      "/api/auth/login",
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
        body: t.Object({ username: t.String(), password: t.String() }),
      }
    )
    .get("/api/auth/me", async ({ currentUserId, set }) => {
      const user = currentUserId ? await users.findById(currentUserId) : null;
      if (!user) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      return user;
    })
    .get("/api/users", async () => {
      return users.list();
    })
    .post(
      "/api/users",
      async ({ body, set }) => {
        try {
          return await users.create(body);
        } catch (e) {
          set.status = 400;
          return { error: (e as Error).message };
        }
      },
      {
        body: t.Object({ username: t.String(), password: t.String() }),
      }
    )
    .delete("/api/users/:id", async ({ params, set }) => {
      try {
        await users.remove(params.id);
        return { ok: true };
      } catch (e) {
        set.status = 400;
        return { error: (e as Error).message };
      }
    })
    .post(
      "/api/extract",
      async ({ body, set }) => {
        const count = body.type === "excel" ? body.rows.length : body.text.length;
        console.log(`[extract] type=${body.type}, count=${count}`);
        try {
          const contacts = await extractContacts(body);
          contacts.forEach((contact, index) => {
            console.log(
              `[extract] contact_${index + 1}: ${JSON.stringify(contact)}`
            );
          });
          return contacts;
        } catch (e) {
          const message = (e as Error).message;
          console.error(`[extract] llm_failed: ${message}`);
          set.status = 502;
          return { error: "llm_failed", message };
        }
      },
      {
        body: ExtractInputSchema,
        response: {
          200: t.Array(ContactSchema),
          401: t.Object({ error: t.String() }),
          502: t.Object({ error: t.String(), message: t.String() }),
        },
      }
    )
    .post(
      "/api/persons/commit",
      async ({ body, set }) => {
        try {
          const result = await commitContacts(
            body.contacts,
            body.sourceFile ?? null
          );
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
