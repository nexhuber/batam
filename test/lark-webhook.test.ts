import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { sendLarkWebhook } from "@/lib/lark";
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("LARK_WEBHOOK_URL", "https://example.invalid/webhook");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("sends the complete stored text and sets a 30 second abort signal", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  fetchMock.mockResolvedValue(Response.json({ code: 0 }));
  await sendLarkWebhook("### News\n\n| Brand | Amount |\n");
  expect(timeout).toHaveBeenCalledWith(30_000);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ msg_type: "text", content: { text: "### News\n\n| Brand | Amount |\n" } });
  expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});
it.each([Response.json({}, { status: 500 }), Response.json({ code: 123, msg: "rejected" }), Response.json({})])("rejects HTTP and Lark application failures", async (response) => {
  fetchMock.mockResolvedValue(response);
  await expect(sendLarkWebhook("news")).rejects.toThrow();
});
it("propagates timeout so the job can retry", async () => {
  fetchMock.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
  await expect(sendLarkWebhook("news")).rejects.toMatchObject({ name: "TimeoutError" });
});
it("fails before fetch when webhook config is absent", async () => {
  vi.stubEnv("LARK_WEBHOOK_URL", "");
  await expect(sendLarkWebhook("news")).rejects.toThrow("not configured");
  expect(fetchMock).not.toHaveBeenCalled();
});
