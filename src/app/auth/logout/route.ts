import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, STATE_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", request.url));
  response.cookies.delete(SESSION_COOKIE);
  response.cookies.set(STATE_COOKIE, "", { path: "/auth/callback", maxAge: 0 });
  return response;
}
