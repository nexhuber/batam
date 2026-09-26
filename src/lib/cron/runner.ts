import { cronJobs } from "@/lib/cron/registry";

export class UnknownCronJobError extends Error {}
export class CronJobRunningError extends Error {}

const running = new Set<string>();

export async function runCronJob(jobId: string) {
  const job = cronJobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new UnknownCronJobError("Unknown cron job");
  if (running.has(jobId)) throw new CronJobRunningError("Cron job is already running");
  running.add(jobId);
  const startedAt = Date.now();
  console.info("cron started", { jobId });
  try {
    const result = await job.run();
    const durationMs = Date.now() - startedAt;
    console.info("cron completed", { jobId, durationMs, ...result });
    return { ...result, jobId, durationMs };
  } catch (error) {
    // Do not log upstream error objects: they can contain credentials or URLs.
    console.error("cron failed", { jobId, durationMs: Date.now() - startedAt });
    throw error;
  } finally {
    running.delete(jobId);
  }
}
