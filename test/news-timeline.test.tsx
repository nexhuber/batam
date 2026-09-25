// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { NewsTimeline } from "@/app/news-timeline";
import type { News, NewsPage } from "@/lib/news";

function news(id: string, type = "weekly_brand_inventory"): News {
  return {
    id,
    created_at: "2026-09-20T17:30:00.000Z",
    is_hide: false,
    content: `# Bản tin ${id}\n\nNội dung preview ${id}.\n\n| Brand | SL |\n| --- | ---: |\n| A | 12 |`,
    news_type: type,
    period_key: "2026-09-20",
  };
}

let onIntersect: IntersectionObserverCallback | undefined;

beforeEach(() => {
  onIntersect = undefined;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { onIntersect = callback; }
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("renders alternating cards, Vietnam time and expandable Markdown table", () => {
  render(<NewsTimeline
    initialPage={{ items: [news("one"), news("two")], nextCursor: null }}
    types={["weekly_brand_inventory"]}
    initialError={false}
    userName="Phuoc"
  />);

  const cards = screen.getAllByRole("article");
  expect(cards[0].parentElement?.className).toContain("news-entry-left");
  expect(cards[1].parentElement?.className).toContain("news-entry-right");
  expect(screen.getAllByText("21/09/2026")).toHaveLength(2);
  expect(screen.getAllByText("00:30")).toHaveLength(2);

  const button = screen.getByRole("button", { name: /Bản tin one/ });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(cards[0].querySelector("table")?.textContent).toContain("12");
  fireEvent.click(button);
  expect(cards[0].querySelector("table")).toBeNull();
});

test("filters on the server and appends a page without duplicate cards", async () => {
  const firstPage: NewsPage = { items: [news("one")], nextCursor: "next-one" };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [news("one"), news("two")], nextCursor: null }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [news("filtered", "other_type")], nextCursor: null }) });
  vi.stubGlobal("fetch", fetchMock);

  render(<NewsTimeline
    initialPage={firstPage}
    types={["weekly_brand_inventory", "other_type"]}
    initialError={false}
    userName="Phuoc"
  />);

  expect(onIntersect).toBeDefined();
  onIntersect!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
  expect(fetchMock.mock.calls[0][0]).toContain("cursor=next-one");
  expect(screen.getByText("Bản tin two").closest(".news-entry")?.className).toContain("news-entry-right");

  fireEvent.click(screen.getByRole("button", { name: "other type" }));
  await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
  await waitFor(() => expect(screen.getByText("Bản tin filtered")).toBeDefined());
  expect(fetchMock.mock.calls[1][0]).toContain("type=other_type");
  expect(fetchMock.mock.calls[1][0]).not.toContain("cursor=");
});
