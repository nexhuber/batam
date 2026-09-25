import { NextRequest, NextResponse } from "next/server";
import { getLarkUser } from "@/lib/lark";
import { readState, signSession, SESSION_COOKIE, SESSION_MAX_AGE, STATE_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const redirectUri = process.env.LARK_REDIRECT_URI;
  if (!redirectUri) return new NextResponse("Lark login is not configured", { status: 503 });
  const origin = new URL(redirectUri).origin;
  const code = request.nextUrl.searchParams.get("code");
  const stateToken = request.nextUrl.searchParams.get("state");
  const state = stateToken ? await readState(stateToken) : null;
  const nonce = request.cookies.get(STATE_COOKIE)?.value;

  async function deny(reason: string) {
    const url = new URL("/login", origin);
    url.searchParams.set("error", reason);
    const response = NextResponse.redirect(url);
    response.cookies.set(STATE_COOKIE, "", { path: "/auth/callback", maxAge: 0 });
    return response;
  }

  if (!code || !state) return deny("invalid_callback");
  if (!nonce || state.nonce !== nonce) return deny("invalid_state");

  try {
    const user = await getLarkUser(code);
    const session = await signSession(user);
    const response = NextResponse.redirect(new URL(state.next, origin));
    response.cookies.set(STATE_COOKIE, "", { path: "/auth/callback", maxAge: 0 });
    response.cookies.set(SESSION_COOKIE, session, {
      httpOnly: true,
      secure: new URL(redirectUri).protocol === "https:",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE,
      path: "/",
    });
    return response;
  } catch (error) {
    console.error("Lark login failed", error);
    return deny("lark_error");
  }
}
