import "server-only";
import { cookies } from "next/headers";
import { readSession, SESSION_COOKIE } from "@/lib/session";

export async function currentUser() {
  const cookieStore = await cookies();
  return readSession(cookieStore.get(SESSION_COOKIE)?.value);
}
