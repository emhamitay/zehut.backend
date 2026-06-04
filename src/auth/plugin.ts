import { Elysia } from "elysia";
import type { AuthService } from "./service";
import { currentUserIdFromRequest } from "./guard";

const PUBLIC_PATHS = new Set<string>([
  "/",
  "/api/auth/setup-required",
  "/api/auth/login",
  "/api/auth/setup",
]);

export function authPlugin(auth: AuthService) {
  return new Elysia()
    .derive(async ({ request }) => {
      const currentUserId = await currentUserIdFromRequest(auth, request);
      return { currentUserId };
    })
    .onBeforeHandle(({ request, currentUserId, set }) => {
      const url = new URL(request.url);
      if (PUBLIC_PATHS.has(url.pathname)) return;
      if (!currentUserId) {
        set.status = 401;
        return { error: "unauthorized" };
      }
    });
}
