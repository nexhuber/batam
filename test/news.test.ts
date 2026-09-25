import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, createQueryJobMock, jobMock, getQueryResultsMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  createQueryJobMock: vi.fn(),
  jobMock: vi.fn(),
  getQueryResultsMock: vi.fn(),
}));

vi.mock("@/lib/bigquery", () => ({
  bigQuery: () => ({
    query: queryMock,
    createQueryJob: createQueryJobMock,
    job: jobMock,
  }),
}));

import { InvalidNewsQueryError, listNews, listNewsTypes, storeNews } from "@/lib/news";

describe("storeNews", () => {
  const originalProject = process.env.BQ_PROJECT;
  const originalDataset = process.env.BQ_DATASET;
  const originalLocation = process.env.BQ_LOCATION;
  const stored = {
    id: "11111111-1111-4111-8111-111111111111",
    created_at: { value: "2026-09-25T02:00:00Z" },
    is_hide: false,
    content: "### Giá trị tồn kho theo Brand",
    news_type: "weekly_brand_inventory",
    period_key: "2026-09-20",
  };
  const input = {
    newsType: stored.news_type,
    periodKey: stored.period_key,
    content: stored.content,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.BQ_PROJECT = "example-project";
    process.env.BQ_DATASET = "news";
    process.env.BQ_LOCATION = "asia-southeast1";
    getQueryResultsMock.mockResolvedValue([[]]);
    createQueryJobMock.mockResolvedValue([{ getQueryResults: getQueryResultsMock }]);
    jobMock.mockReturnValue({ getQueryResults: getQueryResultsMock });
  });

  afterEach(() => {
    if (originalProject === undefined) delete process.env.BQ_PROJECT;
    else process.env.BQ_PROJECT = originalProject;
    if (originalDataset === undefined) delete process.env.BQ_DATASET;
    else process.env.BQ_DATASET = originalDataset;
    if (originalLocation === undefined) delete process.env.BQ_LOCATION;
    else process.env.BQ_LOCATION = originalLocation;
  });

  it("inserts new Markdown news with parameters and returns the stored row", async () => {
    queryMock.mockResolvedValueOnce([[]]).mockImplementationOnce(async () => [[{
      ...stored,
      id: createQueryJobMock.mock.calls[0][0].params.id,
    }]]);

    const result = await storeNews(input);
    const insert = createQueryJobMock.mock.calls[0][0];

    expect(result).toEqual({
      created: true,
      news: { ...stored, id: insert.params.id, created_at: "2026-09-25T02:00:00.000Z" },
    });
    expect(insert.jobId).toMatch(/^store_news_v2_[a-f0-9]{64}$/);
    expect(insert.location).toBe("asia-southeast1");
    expect(insert.query).toContain("`example-project.news.news_history`");
    expect(insert.query).toContain("FROM UNNEST([1])\n        WHERE NOT EXISTS");
    expect(insert.query).toContain("WHERE NOT EXISTS");
    expect(insert.params).toMatchObject(input);
    expect(insert.params.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getQueryResultsMock).toHaveBeenCalledOnce();
  });

  it("returns the existing news when cron retries the same period", async () => {
    queryMock.mockResolvedValueOnce([[stored]]);

    await expect(storeNews(input)).resolves.toEqual({
      created: false,
      news: { ...stored, created_at: "2026-09-25T02:00:00.000Z" },
    });
    expect(createQueryJobMock).not.toHaveBeenCalled();
  });

  it("preserves Markdown whitespace in the stored content", async () => {
    const markdown = "### Báo cáo\n\n| Brand | VND |\n";
    queryMock.mockResolvedValueOnce([[]]).mockImplementationOnce(async () => [[{
      ...stored,
      id: createQueryJobMock.mock.calls[0][0].params.id,
      content: markdown,
    }]]);

    const result = await storeNews({ ...input, content: markdown });

    expect(createQueryJobMock.mock.calls[0][0].params.content).toBe(markdown);
    expect(result.news.content).toBe(markdown);
  });

  it("uses distinct job IDs for different periods", async () => {
    queryMock.mockResolvedValueOnce([[]]).mockImplementationOnce(async () => [[{
      ...stored,
      id: createQueryJobMock.mock.calls[0][0].params.id,
    }]]).mockResolvedValueOnce([[]]).mockImplementationOnce(async () => [[{
      ...stored,
      id: createQueryJobMock.mock.calls[1][0].params.id,
      period_key: "2026-09-27",
    }]]);

    await storeNews(input);
    await storeNews({ ...input, periodKey: "2026-09-27" });

    expect(createQueryJobMock).toHaveBeenCalledTimes(2);
    expect(createQueryJobMock.mock.calls[0][0].jobId)
      .not.toBe(createQueryJobMock.mock.calls[1][0].jobId);
  });

  it("waits for an already submitted job on concurrent retry", async () => {
    queryMock.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[stored]]);
    createQueryJobMock.mockRejectedValueOnce({ code: 409 });

    const result = await storeNews(input);

    expect(jobMock).toHaveBeenCalledWith(expect.stringMatching(/^store_news_/), {
      location: "asia-southeast1",
    });
    expect(getQueryResultsMock).toHaveBeenCalledOnce();
    expect(result.created).toBe(false);
  });

  it.each([
    [{ ...input, newsType: " " }, "newsType"],
    [{ ...input, periodKey: "" }, "periodKey"],
    [{ ...input, content: "\n " }, "content"],
  ])("rejects empty input before querying BigQuery", async (value, field) => {
    await expect(storeNews(value)).rejects.toThrow(`${field} must be a non-empty string`);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("propagates BigQuery lookup and insert failures", async () => {
    queryMock.mockRejectedValueOnce(new Error("lookup failed"));
    await expect(storeNews(input)).rejects.toThrow("lookup failed");

    queryMock.mockResolvedValueOnce([[]]);
    createQueryJobMock.mockRejectedValueOnce(new Error("insert failed"));
    await expect(storeNews(input)).rejects.toThrow("insert failed");
  });

  it("lists ten visible news newest first and continues after the last ID", async () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({
      ...stored,
      id: `news-${String(20 - index).padStart(2, "0")}`,
      created_at: { value: "2026-09-25T02:00:00.123456Z" },
    }));
    queryMock.mockResolvedValueOnce([rows]).mockResolvedValueOnce([[{
      ...stored,
      id: "older-news",
      created_at: { value: "2026-09-24T02:00:00Z" },
    }]]);

    const first = await listNews({ type: "weekly_brand_inventory" });
    const second = await listNews({ type: "weekly_brand_inventory", cursor: first.nextCursor! });
    const firstQuery = queryMock.mock.calls[0][0];
    const secondQuery = queryMock.mock.calls[1][0];

    expect(first.items).toHaveLength(10);
    expect(first.items[0].id).toBe("news-20");
    expect(first.items[9].id).toBe("news-11");
    expect(firstQuery.query).toContain("is_hide = FALSE");
    expect(firstQuery.query).toContain("news_type = @newsType");
    expect(firstQuery.query).toContain("ORDER BY created_at DESC, id DESC");
    expect(firstQuery.query).toContain("LIMIT 11");
    expect(secondQuery.query).toContain("created_at = TIMESTAMP(@cursorCreatedAt) AND id < @cursorId");
    expect(secondQuery.params).toMatchObject({
      newsType: "weekly_brand_inventory",
      cursorCreatedAt: "2026-09-25T02:00:00.123456Z",
      cursorId: "news-11",
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects malformed cursors and cursors from another type", async () => {
    await expect(listNews({ cursor: "bad cursor!" })).rejects.toBeInstanceOf(InvalidNewsQueryError);
    const otherTypeCursor = Buffer.from(JSON.stringify({
      createdAt: "2026-09-25T02:00:00.000Z",
      id: "some-id",
      type: "other_type",
    })).toString("base64url");
    await expect(listNews({ type: "weekly_brand_inventory", cursor: otherTypeCursor }))
      .rejects.toBeInstanceOf(InvalidNewsQueryError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("lists only visible news types", async () => {
    queryMock.mockResolvedValueOnce([[{ news_type: "monthly_revenue" }, { news_type: "weekly_brand_inventory" }]]);

    await expect(listNewsTypes()).resolves.toEqual(["monthly_revenue", "weekly_brand_inventory"]);
    expect(queryMock.mock.calls[0][0].query).toContain("WHERE is_hide = FALSE");
  });
});
