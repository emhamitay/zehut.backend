import { SignJWT, jwtVerify } from "jose";

const ALG = "HS256";
const DEFAULT_EXPIRES = "7d";

export type TokenPayload = { sub: string };

export type AuthService = ReturnType<typeof makeAuthService>;

export function makeAuthService(opts: {
  secret: string;
  expiresIn?: string;
}) {
  const secret = new TextEncoder().encode(opts.secret);
  const expiresIn = opts.expiresIn ?? DEFAULT_EXPIRES;

  async function signToken(payload: TokenPayload): Promise<string> {
    return new SignJWT({ sub: payload.sub })
      .setProtectedHeader({ alg: ALG })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(secret);
  }

  async function verifyToken(token: string): Promise<TokenPayload | null> {
    try {
      const { payload } = await jwtVerify(token, secret);
      if (typeof payload.sub !== "string") return null;
      return { sub: payload.sub };
    } catch {
      return null;
    }
  }

  return { signToken, verifyToken };
}
