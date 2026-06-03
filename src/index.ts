import { buildApp } from "./app";
import { makeUserRepo } from "./users/repo";
import { makeUserService } from "./users/service";
import { makeAuthService } from "./auth/service";
import { bootstrapAdmin } from "./auth/bootstrap";

const PORT: number = 4000;

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

const app = buildApp({ users, auth }).listen(PORT);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
