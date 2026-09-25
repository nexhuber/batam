import { createHash, randomUUID } from "node:crypto";

import { bigQuery } from "@/lib/bigquery";

export type News = {
  id: string;
  created_at: string;
  is_hide: boolean;
  content: string;
  news_type: string;
  period_key: string;
};

export type StoreNewsInput = {
  newsType: string;
  periodKey: string;
  content: string;
};

export type StoreNewsResult = {
  news: News;
  created: boolean;
};

export type NewsPage = {
  items: News[];
  nextCursor: string | null;
};

export class InvalidNewsQueryError extends Error {}

function requiredText(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function tableName(): string {
  const project = process.env.BQ_PROJECT;
  const dataset = process.env.BQ_DATASET;
  if (!project || !/^[A-Za-z0-9_-]+$/.test(project)) {
    throw new Error("BQ_PROJECT is not configured or is invalid");
  }
  if (!dataset || !/^[A-Za-z0-9_]+$/.test(dataset)) {
    throw new Error("BQ_DATASET is not configured or is invalid");
  }
  return `\`${project}.${dataset}.news_history\``;
}

function toNews(row: Record<string, unknown>): News {
  const timestamp = row.created_at;
  const value = timestamp && typeof timestamp === "object" && "value" in timestamp
    ? timestamp.value
    : timestamp;
  const createdAt = new Date(String(value));
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error("BigQuery returned an invalid news created_at");
  }
  return {
    id: String(row.id),
    created_at: createdAt.toISOString(),
    is_hide: row.is_hide === true,
    content: String(row.content),
    news_type: String(row.news_type),
    period_key: String(row.period_key),
  };
}

function rawCreatedAt(row: Record<string, unknown>): string {
  const timestamp = row.created_at;
  return String(timestamp && typeof timestamp === "object" && "value" in timestamp
    ? timestamp.value
    : timestamp);
}

/** Store one generated news item per news type and period. */
export async function storeNews(input: StoreNewsInput): Promise<StoreNewsResult> {
  const newsType = requiredText(input.newsType, "newsType");
  const periodKey = requiredText(input.periodKey, "periodKey");
  requiredText(input.content, "content");
  const content = input.content;
  const table = tableName();
  const client = bigQuery();
  const location = process.env.BQ_LOCATION || "asia-southeast1";
  const lookup = {
    query: `SELECT id, created_at, is_hide, content, news_type, period_key
      FROM ${table}
      WHERE news_type = @newsType AND period_key = @periodKey
      ORDER BY created_at, id
      LIMIT 1`,
    params: { newsType, periodKey },
    location,
  };

  const [existingRows] = await client.query(lookup);
  if (existingRows.length > 0) {
    return { news: toNews(existingRows[0]), created: false };
  }

  const id = randomUUID();
  const jobId = `store_news_v2_${createHash("sha256")
    .update(JSON.stringify([process.env.BQ_PROJECT, process.env.BQ_DATASET, newsType, periodKey]))
    .digest("hex")}`;
  let job;
  try {
    [job] = await client.createQueryJob({
      query: `INSERT INTO ${table} (id, news_type, period_key, content)
        SELECT @id, @newsType, @periodKey, @content
        FROM UNNEST([1])
        WHERE NOT EXISTS (
          SELECT 1 FROM ${table}
          WHERE news_type = @newsType AND period_key = @periodKey
        )`,
      params: { id, newsType, periodKey, content },
      location,
      jobId,
    });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || Number(error.code) !== 409) {
      throw error;
    }
    job = client.job(jobId, { location });
  }

  await job.getQueryResults();
  const [storedRows] = await client.query(lookup);
  if (storedRows.length === 0) {
    throw new Error("BigQuery completed the news insert but returned no stored news");
  }
  const news = toNews(storedRows[0]);
  return { news, created: news.id === id };
}

type NewsCursor = {
  createdAt: string;
  id: string;
  type: string;
};

function readCursor(encoded: string, type: string): NewsCursor {
  try {
    if (encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      throw new Error("invalid encoding");
    }
    const cursor = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<NewsCursor>;
    if (
      typeof cursor.createdAt !== "string" ||
      Number.isNaN(Date.parse(cursor.createdAt)) ||
      typeof cursor.id !== "string" || !cursor.id ||
      cursor.type !== type
    ) {
      throw new Error("invalid cursor values");
    }
    return cursor as NewsCursor;
  } catch {
    throw new InvalidNewsQueryError("Invalid news cursor");
  }
}

/** Return up to ten visible news items, newest first. */
export async function listNews(options: { type?: string; cursor?: string } = {}): Promise<NewsPage> {
  const type = options.type?.trim() || "";
  if (type.length > 200) throw new InvalidNewsQueryError("Invalid news type");
  const cursor = options.cursor ? readCursor(options.cursor, type) : null;
  const table = tableName();
  const conditions = ["is_hide = FALSE"];
  const params: Record<string, string> = {};
  if (type) {
    conditions.push("news_type = @newsType");
    params.newsType = type;
  }
  if (cursor) {
    conditions.push(`(created_at < TIMESTAMP(@cursorCreatedAt)
      OR (created_at = TIMESTAMP(@cursorCreatedAt) AND id < @cursorId))`);
    params.cursorCreatedAt = cursor.createdAt;
    params.cursorId = cursor.id;
  }

  const [rows] = await bigQuery().query({
    query: `SELECT id, created_at, is_hide, content, news_type, period_key
      FROM ${table}
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT 11`,
    params,
    location: process.env.BQ_LOCATION || "asia-southeast1",
  });
  const items = rows.slice(0, 10).map(toNews);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > 10 && last
      ? Buffer.from(JSON.stringify({ createdAt: rawCreatedAt(rows[9]), id: last.id, type })).toString("base64url")
      : null,
  };
}

/** List visible news types for the feed filter. */
export async function listNewsTypes(): Promise<string[]> {
  const [rows] = await bigQuery().query({
    query: `SELECT DISTINCT news_type
      FROM ${tableName()}
      WHERE is_hide = FALSE
      ORDER BY news_type`,
    location: process.env.BQ_LOCATION || "asia-southeast1",
  });
  return rows.map((row) => String(row.news_type));
}
