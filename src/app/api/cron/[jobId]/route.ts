import { timingSafeEqual } from "node:crypto";

import { CronJobRunningError, runCronJob, UnknownCronJobError } from "@/lib/cron/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim()) {
    return Response.json({ error: "Cron is not configured" }, { status: 503 });
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") || "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { jobId } = await context.params;
  try {
    return Response.json(await runCronJob(jobId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof UnknownCronJobError ? 404 : error instanceof CronJobRunningError ? 409 : 500;
    return Response.json({
      jobId,
      error: status === 500 ? "Cron job failed; inspect service logs" : (error as Error).message,
    }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
