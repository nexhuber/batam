import { NextRequest } from "next/server";
import { expect, it, vi } from "vitest";
const { readSession } = vi.hoisted(() => ({ readSession: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/session", () => ({ readSession, SESSION_COOKIE: "session" }));
import { proxy } from "@/proxy";
it("lets cron reach its bearer auth without redirecting to OAuth", async () => {
  const response = await proxy(new NextRequest("http://localhost/api/cron/weekly-brand-inventory"));
  expect(response.headers.get("location")).toBeNull();
  expect(readSession).not.toHaveBeenCalled();
});
it("still protects other pages", async () => {
  const response = await proxy(new NextRequest("http://localhost/private"));
  expect(response.headers.get("location")).toContain("/login");
});
