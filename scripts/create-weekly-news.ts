import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), true);

const { execute } = await import("@/lib/brand-inventory-markdown");

try {
  const { news, created } = await execute();
  console.log(`${created ? "Created" : "Already exists"}: ${news.id} (${news.period_key})`);
} catch (error) {
  console.error("Could not create weekly Brand inventory news:", error);
  process.exitCode = 1;
}
