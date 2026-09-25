import "server-only";
import { BigQuery } from "@google-cloud/bigquery";

let client: BigQuery | undefined;

export function bigQuery(): BigQuery {
  const projectId = process.env.BQ_PROJECT;
  if (!projectId) throw new Error("BQ_PROJECT is not configured");
  client ??= new BigQuery({ projectId, location: process.env.BQ_LOCATION || "asia-southeast1" });
  return client;
}

export async function checkBigQueryConnection(): Promise<number> {
  const [rows] = await bigQuery().query({
    query: "SELECT 1 AS connection_ok",
    location: process.env.BQ_LOCATION || "asia-southeast1",
  });
  const value: unknown = rows[0]?.connection_ok;
  if (value !== 1) throw new Error("BigQuery returned an unexpected result");
  return value;
}
