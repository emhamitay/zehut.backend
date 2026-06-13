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

export type CorsOrigin = RegExp | string;

export type AppDeps = {
  users: UserService;
  auth: AuthService;
  corsOrigin?: CorsOrigin | CorsOrigin[];
};

const LOCALHOST_ORIGIN = /^http:\/\/localhost(?::\d+)?$/;

export function buildApp(deps: AppDeps) {
  const { users, auth } = deps;
  // Always allow localhost (dev); add any configured production origins on top.
  const extra = deps.corsOrigin
    ? Array.isArray(deps.corsOrigin)
      ? deps.corsOrigin
      : [deps.corsOrigin]
    : [];
  const corsOrigin: CorsOrigin[] = [LOCALHOST_ORIGIN, ...extra];

  return new Elysia()
    .use(cors({ origin: corsOrigin }))
    .use(authPlugin(auth))
    .get("/", () => `Hello Zehut Yehudit Server!\nCors Origin: ${corsOrigin}`)
    .use(authRoutes(users, auth))
    .use(usersRoutes(users, auth))
    .use(extractRoutes(auth))
    .use(personsRoutes(auth))
    .use(contactPagesRoutes(auth));
}
