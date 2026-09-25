import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "batam_session";
export const STATE_COOKIE = "batam_oauth_state";
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const ISSUER = "batam-dashboard";

export type LarkUser = {
  id: string;
  name?: string;
  email?: string;
};

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return new TextEncoder().encode(secret);
}

export function safeNextPath(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) {
    return "/";
  }
  return value;
}

export async function signSession(user: LarkUser): Promise<string> {
  return new SignJWT({ user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience("session")
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secretKey());
}

export async function readSession(token: string | undefined): Promise<LarkUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: "session",
    });
    const user = payload.user;
    if (!user || typeof user !== "object" || !("id" in user) || typeof user.id !== "string" || !user.id) {
      return null;
    }
    return {
      id: user.id,
      name: "name" in user && typeof user.name === "string" ? user.name : undefined,
      email: "email" in user && typeof user.email === "string" ? user.email : undefined,
    };
  } catch {
    return null;
  }
}

export async function signState(next: string, nonce: string): Promise<string> {
  return new SignJWT({ next, nonce })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience("lark-oauth-state")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secretKey());
}

export async function readState(token: string): Promise<{ next: string; nonce: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: "lark-oauth-state",
    });
    if (typeof payload.next !== "string" || typeof payload.nonce !== "string" || !payload.nonce) {
      return null;
    }
    return { next: safeNextPath(payload.next), nonce: payload.nonce };
  } catch {
    return null;
  }
}
