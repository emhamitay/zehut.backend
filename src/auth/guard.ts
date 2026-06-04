import type { AuthService } from "./service";

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const [scheme, token] = h.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export async function currentUserIdFromRequest(
  auth: AuthService,
  request: Request
): Promise<string | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const payload = await auth.verifyToken(token);
  return payload?.sub ?? null;
}

export function requireAuth(auth: AuthService) {
  return async (ctx: any) => {
    const { request, set } = ctx;
    const currentUserId = await currentUserIdFromRequest(auth, request);
    if (!currentUserId) {
      set.status = 401;
      return { error: "unauthorized" };
    }
  };
}
