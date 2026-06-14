import { buildApp } from "./app";
import { makeUserRepo } from "./users/repo";
import { makeUserService } from "./users/service";
import { makeAuthService } from "./auth/service";
import { bootstrapAdmin } from "./auth/bootstrap";
import { parseUseAi } from "./extract/routes";

const PORT: number = 4000;

// Required flag — throws on startup if missing/invalid (like DATABASE_URL),
// so a misconfigured server never silently leaks PII to the LLM.
const useAi = parseUseAi();
console.log(`[extract] AI extraction is ${useAi ? "enabled" : "disabled"}`);

const JWT_SECRET = Bun.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn(
    "[auth] JWT_SECRET not set — using insecure dev default. Set JWT_SECRET in your .env for production."
  );
}

const users = makeUserService(makeUserRepo());
const auth = makeAuthService({
  secret: JWT_SECRET ?? "dev-insecure-secret-change-me",
});

const seeded = await bootstrapAdmin(users, {
  username: Bun.env.BOOTSTRAP_ADMIN_USERNAME,
  password: Bun.env.BOOTSTRAP_ADMIN_PASSWORD,
});
if (seeded) {
  console.log(
    `[auth] seeded admin user "${Bun.env.BOOTSTRAP_ADMIN_USERNAME}" from .env`
  );
}

// CORS_ORIGIN may be a single URL or a comma-separated list of frontend origins.
const corsOrigin = (Bun.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);
if (corsOrigin.length === 0) {
  console.warn(
    "[cors] CORS_ORIGIN not set — only localhost origins are allowed. Set CORS_ORIGIN to your frontend URL in production."
  );
}

const app = buildApp({ users, auth, corsOrigin, useAi }).listen(PORT);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
