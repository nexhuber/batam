import schedules from "@/lib/cron/schedules.json";
import { weeklyBrandInventory } from "@/lib/cron/jobs/weekly-brand-inventory";

type CronResult = Record<string, unknown>;
type CronHandler = () => Promise<CronResult>;

const handlers: Record<string, CronHandler> = {
  "weekly-brand-inventory": weeklyBrandInventory,
};

export const cronJobs = schedules.map((schedule) => {
  const run = handlers[schedule.id];
  if (!run) throw new Error(`Missing cron handler: ${schedule.id}`);
  return { ...schedule, run };
});
