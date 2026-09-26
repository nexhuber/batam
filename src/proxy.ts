import { NextRequest, NextResponse } from "next/server";
import { readSession, SESSION_COOKIE } from "@/lib/session";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname === "/login" || pathname.startsWith("/auth/") || pathname === "/api/health" || pathname === "/api/news" || pathname.startsWith("/api/cron/")) {
    return NextResponse.next();
  }

  const user = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (user) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
