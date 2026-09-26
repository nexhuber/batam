import { setTimeout as delay } from "node:timers/promises";

import { execute } from "@/lib/brand-inventory-markdown";
import { sendLarkWebhook } from "@/lib/lark";

export async function weeklyBrandInventory() {
  const { news, created } = await execute();
  const waits = [2_000, 5_000];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sendLarkWebhook(news.content);
      return { newsId: news.id, periodKey: news.period_key, created, attempts: attempt };
    } catch {
      console.warn("cron webhook attempt failed", {
        jobId: "weekly-brand-inventory", newsId: news.id, attempt,
      });
      if (attempt === 3) throw new Error("Lark delivery failed after 3 attempts; news remains saved");
      await delay(waits[attempt - 1]);
    }
  }
  throw new Error("Unreachable webhook retry state");
}
