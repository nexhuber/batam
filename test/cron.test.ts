import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, sendMock } = vi.hoisted(() => ({ executeMock: vi.fn(), sendMock: vi.fn() }));
vi.mock("@/lib/brand-inventory-markdown", () => ({ execute: executeMock }));
vi.mock("@/lib/lark", () => ({ sendLarkWebhook: sendMock }));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));

import { setTimeout as delay } from "node:timers/promises";
import { weeklyBrandInventory } from "@/lib/cron/jobs/weekly-brand-inventory";
import { CronJobRunningError, runCronJob, UnknownCronJobError } from "@/lib/cron/runner";
import { POST } from "@/app/api/cron/[jobId]/route";

const saved = { news: { id: "news-1", content: "Saved Markdown", period_key: "2026-09-27" }, created: true };

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockReset().mockResolvedValue(saved);
  sendMock.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("CRON_SECRET", "test-secret");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("weekly cron", () => {
  it.each([true, false])("sends stored content after saving, created=%s", async (created) => {
    executeMock.mockResolvedValue({ ...saved, created });
    expect(await weeklyBrandInventory()).toEqual({ newsId: "news-1", periodKey: "2026-09-27", created, attempts: 1 });
    expect(sendMock).toHaveBeenCalledWith(saved.news.content);
    expect(executeMock.mock.invocationCallOrder[0]).toBeLessThan(sendMock.mock.invocationCallOrder[0]);
  });
  it.each(["Missing snapshots", "BigQuery failed"])("does not send if report/store fails: %s", async (message) => {
    executeMock.mockRejectedValue(new Error(message));
    await expect(weeklyBrandInventory()).rejects.toThrow(message);
    expect(sendMock).not.toHaveBeenCalled();
  });
  it("retries only delivery and succeeds on the third attempt", async () => {
    sendMock.mockRejectedValueOnce(new Error("HTTP 500")).mockRejectedValueOnce(new DOMException("Timeout", "TimeoutError"));
    expect((await weeklyBrandInventory()).attempts).toBe(3);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([2000, 5000]);
  });
  it("stops after exactly three failures without rewriting the news", async () => {
    sendMock.mockRejectedValue(new Error("unavailable"));
    await expect(weeklyBrandInventory()).rejects.toThrow("after 3 attempts");
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});

describe("runner and API", () => {
  function request(token: string | null = "Bearer test-secret", id = "weekly-brand-inventory") {
    return POST(new Request(`http://localhost/api/cron/${id}`, { method: "POST", headers: token ? { Authorization: token } : {} }), {
      params: Promise.resolve({ jobId: id }),
    });
  }
  it.each([null, "Bearer incorrect", "Bearer test-secrex"])("rejects bad authorization: %s", async (token) => {
    expect((await request(token)).status).toBe(401);
    expect(executeMock).not.toHaveBeenCalled();
  });
  it("fails closed without configured secret", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await request()).status).toBe(503);
    expect(executeMock).not.toHaveBeenCalled();
  });
  it("returns IDs, period and attempts on success", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ jobId: "weekly-brand-inventory", newsId: "news-1", periodKey: "2026-09-27", created: true, attempts: 1 });
  });
  it("returns 404 without running for unknown jobs", async () => {
    expect((await request("Bearer test-secret", "unknown")).status).toBe(404);
    await expect(runCronJob("unknown")).rejects.toBeInstanceOf(UnknownCronJobError);
    expect(executeMock).not.toHaveBeenCalled();
  });
  it("blocks concurrent runs and releases the lock on completion", async () => {
    let resolve!: (value: typeof saved) => void;
    executeMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = runCronJob("weekly-brand-inventory");
    await expect(runCronJob("weekly-brand-inventory")).rejects.toBeInstanceOf(CronJobRunningError);
    expect((await request()).status).toBe(409);
    resolve(saved);
    await first;
    expect((await request()).status).toBe(200);
  });
  it("releases the lock after failure and does not expose upstream secrets", async () => {
    executeMock.mockRejectedValueOnce(new Error("https://secret-webhook"));
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret-webhook");
    expect((await request()).status).toBe(200);
  });
});
