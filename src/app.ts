import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import type { UserService } from "./users/service";
import type { AuthService } from "./auth/service";
import { authPlugin } from "./auth/plugin";
import { authRoutes } from "./auth/routes";
import { usersRoutes } from "./users/routes";
import { extractRoutes } from "./extract/routes";
import { personsRoutes } from "./persons/routes";
import { contactPagesRoutes } from "./contact-pages/routes";

export type AppDeps = {
  users: UserService;
  auth: AuthService;
  corsOrigin?: RegExp | string;
};

export function buildApp(deps: AppDeps) {
  const { users, auth } = deps;
  const corsOrigin = deps.corsOrigin ?? /^http:\/\/localhost(?::\d+)?$/;

  return new Elysia()
    .use(cors({ origin: corsOrigin }))
    .use(authPlugin(auth))
    .get("/", () => "Hello Zehut Yehudit Server!")
    .use(authRoutes(users, auth))
    .use(usersRoutes(users, auth))
    .use(extractRoutes(auth))
    .use(personsRoutes(auth))
    .use(contactPagesRoutes(auth));
}
