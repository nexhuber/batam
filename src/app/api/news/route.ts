import type { NextRequest } from "next/server";

import { currentUser } from "@/lib/current-user";
import { InvalidNewsQueryError, listNews } from "@/lib/news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!(await currentUser())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const page = await listNews({
      type: request.nextUrl.searchParams.get("type") || undefined,
      cursor: request.nextUrl.searchParams.get("cursor") || undefined,
    });
    return Response.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvalidNewsQueryError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("Could not load news", error);
    return Response.json({ error: "Could not load news" }, { status: 500 });
  }
}
