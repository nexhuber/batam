import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentUserMock, listNewsMock } = vi.hoisted(() => ({
  currentUserMock: vi.fn(),
  listNewsMock: vi.fn(),
}));

vi.mock("@/lib/current-user", () => ({ currentUser: currentUserMock }));
vi.mock("@/lib/news", () => ({
  listNews: listNewsMock,
  InvalidNewsQueryError: class InvalidNewsQueryError extends Error {},
}));

import { GET } from "@/app/api/news/route";
import { InvalidNewsQueryError } from "@/lib/news";

describe("GET /api/news", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects unauthenticated requests without reading news", async () => {
    currentUserMock.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/news"));

    expect(response.status).toBe(401);
    expect(listNewsMock).not.toHaveBeenCalled();
  });

  it("passes type and cursor to the reader and disables caching", async () => {
    currentUserMock.mockResolvedValue({ id: "lark-user" });
    listNewsMock.mockResolvedValue({ items: [], nextCursor: null });
    const response = await GET(new NextRequest("http://localhost/api/news?type=weekly_brand_inventory&cursor=abc"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(listNewsMock).toHaveBeenCalledWith({ type: "weekly_brand_inventory", cursor: "abc" });
    await expect(response.json()).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("reports an invalid cursor as a client error", async () => {
    currentUserMock.mockResolvedValue({ id: "lark-user" });
    listNewsMock.mockRejectedValue(new InvalidNewsQueryError("Invalid news cursor"));
    const response = await GET(new NextRequest("http://localhost/api/news?cursor=invalid"));

    expect(response.status).toBe(400);
  });
});
