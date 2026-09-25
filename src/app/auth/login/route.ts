import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { safeNextPath, signState, STATE_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const appId = process.env.LARK_APP_ID;
  const redirectUri = process.env.LARK_REDIRECT_URI;
  if (!appId || !process.env.LARK_APP_SECRET || !redirectUri) {
    return new NextResponse("Lark login is not configured", { status: 503 });
  }

  const nonce = randomUUID();
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));
  const state = await signState(next, nonce);
  const url = new URL("/open-apis/authen/v1/authorize", process.env.LARK_BASE_URL || "https://open.larksuite.com");
  url.searchParams.set("app_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  const response = NextResponse.redirect(url);
  response.cookies.set(STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: new URL(redirectUri).protocol === "https:",
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/auth/callback",
  });
  return response;
}
