import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { storeNewsMock } = vi.hoisted(() => ({ storeNewsMock: vi.fn() }));
vi.mock("@/lib/news", () => ({ storeNews: storeNewsMock }));

import {
  getBrandInventoryData,
  getWeeklyBrandInventoryData,
} from "@/lib/brand-inventory";
import { execute, formatBrandInventoryMarkdown } from "@/lib/brand-inventory-markdown";

describe("Brand inventory report in Batam", () => {
  const originalBaseUrl = process.env.MONARCH_API_BASE_URL;
  const originalToken = process.env.BRAND_PIVOT_API_TOKEN;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T18:00:00Z")); // Thursday in Vietnam
    process.env.MONARCH_API_BASE_URL = "https://monarch.example.com/";
    process.env.BRAND_PIVOT_API_TOKEN = "shared-test-token";
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalBaseUrl === undefined) delete process.env.MONARCH_API_BASE_URL;
    else process.env.MONARCH_API_BASE_URL = originalBaseUrl;
    if (originalToken === undefined) delete process.env.BRAND_PIVOT_API_TOKEN;
    else process.env.BRAND_PIVOT_API_TOKEN = originalToken;
  });

  it("requests two explicit snapshots and passes the period", async () => {
    fetchMock.mockResolvedValue(Response.json({
      current_snapshot: "2026-09-20",
      previous_snapshot: "2026-09-13",
      rows: [],
    }));

    const data = await getBrandInventoryData("2026-09-13", "2026-09-20", "month");
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];

    expect(url.searchParams.get("previous_snapshot")).toBe("2026-09-13");
    expect(url.searchParams.get("current_snapshot")).toBe("2026-09-20");
    expect(url.searchParams.get("period")).toBe("month");
    expect(data.period).toBe("month");
    expect([data.previous_snapshot, data.current_snapshot]).toEqual(["2026-09-13", "2026-09-20"]);
  });

  it("aggregates inventory and formats Markdown for the latest Sunday snapshots", async () => {
    fetchMock.mockResolvedValue(Response.json({
      current_snapshot: "2026-09-20",
      previous_snapshot: "2026-09-13",
      rows: [
        { brand: "LIXCO", current_value: 260, previous_value: 180 },
        { brand: "Colorkey", current_value: 10, previous_value: 10 },
        { brand: "New Brand", current_value: 50, previous_value: 0 },
      ],
    }));

    const data = await getWeeklyBrandInventoryData();
    const markdown = formatBrandInventoryMarkdown(data);
    const [url, options] = fetchMock.mock.calls[0] as [URL, RequestInit];

    expect(url.searchParams.get("period")).toBe("week");
    expect(url.searchParams.get("current_snapshot")).toBe("2026-09-20");
    expect(url.searchParams.get("previous_snapshot")).toBe("2026-09-13");
    expect(options.headers).toEqual({
      Authorization: "Bearer shared-test-token",
      Accept: "application/json",
    });
    expect([data.current_snapshot, data.previous_snapshot]).toEqual(["2026-09-20", "2026-09-13"]);
    expect(data.rows).toEqual(expect.arrayContaining([
      { brand: "LIXCO", current_value: 260, previous_value: 180, delta_value: 80,
        delta_percent: 80 / 180 * 100 },
      { brand: "Colorkey", current_value: 10, previous_value: 10, delta_value: 0,
        delta_percent: 0 },
      { brand: "New Brand", current_value: 50, previous_value: 0, delta_value: 50,
        delta_percent: null },
    ]));
    expect(data.total).toEqual({ current_value: 320, previous_value: 190, delta_value: 130,
      delta_percent: 130 / 190 * 100 });
    expect(markdown).toContain("| LIXCO | 260 | 180 | +80 (44.4%) |");
    expect(markdown).toContain("| Colorkey | 10 | 10 | — |");
    expect(markdown).toContain("| New Brand | 50 | 0 | +50 (new) |");
    expect(markdown).toContain("| **Grand Total** | **320** | **190** | **+130 (68.4%)** |");
  });

  it("executes the weekly report and stores one news item for its Sunday", async () => {
    fetchMock.mockResolvedValue(Response.json({
      current_snapshot: "2026-09-20",
      previous_snapshot: "2026-09-13",
      rows: [],
    }));
    const stored = { news: { id: "news-id" }, created: true };
    storeNewsMock.mockResolvedValue(stored);

    await expect(execute()).resolves.toBe(stored);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(storeNewsMock).toHaveBeenCalledWith({
      newsType: "weekly_brand_inventory",
      periodKey: "2026-09-20",
      content: expect.stringContaining("Kỳ này: **2026-09-20** · Kỳ trước: **2026-09-13**"),
    });
  });

  it("uses the current day when it is Sunday in Vietnam", async () => {
    vi.setSystemTime(new Date("2026-09-26T17:00:00Z"));
    fetchMock.mockResolvedValue(Response.json({
      current_snapshot: "2026-09-27",
      previous_snapshot: "2026-09-20",
      rows: [],
    }));

    const data = await getWeeklyBrandInventoryData();
    expect([data.current_snapshot, data.previous_snapshot]).toEqual(["2026-09-27", "2026-09-20"]);
    expect(data.rows).toEqual([]);
  });

  it("reports a missing Sunday returned by Monarch", async () => {
    fetchMock.mockResolvedValue(Response.json({
      error: "snapshot_not_found",
      missing_snapshots: ["2026-09-13"],
    }, { status: 404 }));
    await expect(getWeeklyBrandInventoryData()).rejects.toThrow("2026-09-13");
  });

  it("fails clearly on HTTP errors, malformed payloads, and timeouts", async () => {
    fetchMock.mockResolvedValue(Response.json({ message: "token rejected" }, { status: 401 }));
    await expect(getWeeklyBrandInventoryData()).rejects.toThrow("HTTP 401: token rejected");

    fetchMock.mockResolvedValue(Response.json({ current_snapshot: "2026-09-20", rows: [] }));
    await expect(getWeeklyBrandInventoryData()).rejects.toThrow("expected 2026-09-20 and 2026-09-13");

    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(getWeeklyBrandInventoryData()).rejects.toThrow("timed out after 2 minutes");
  });

  it("requires the API URL and shared token", async () => {
    delete process.env.MONARCH_API_BASE_URL;
    await expect(getWeeklyBrandInventoryData()).rejects.toThrow("MONARCH_API_BASE_URL");
    process.env.MONARCH_API_BASE_URL = "https://monarch.example.com";
    delete process.env.BRAND_PIVOT_API_TOKEN;
    await expect(getWeeklyBrandInventoryData()).rejects.toThrow("BRAND_PIVOT_API_TOKEN");
  });
});
