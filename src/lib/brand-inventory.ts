export type BrandInventoryPeriod = "day" | "week" | "month";

export type BrandInventoryValue = {
  brand: string;
  current_value: number;
  previous_value: number;
  delta_value: number;
  delta_percent: number | null;
};

export type BrandInventoryComparison = {
  current_snapshot: string;
  previous_snapshot: string;
  period: BrandInventoryPeriod;
  rows: BrandInventoryValue[];
  total: Omit<BrandInventoryValue, "brand">;
};

type BrandPivotApiResponse = {
  current_snapshot?: unknown;
  previous_snapshot?: unknown;
  warning?: unknown;
  rows?: unknown;
};

function percentChange(current: number, previous: number): number | null {
  return previous > 0 ? ((current - previous) / previous) * 100 : null;
}

/** Fetch and compare inventory values for two explicit snapshots. */
export async function getBrandInventoryData(
  startDate: string,
  endDate: string,
  period: BrandInventoryPeriod,
): Promise<BrandInventoryComparison> {
  const baseUrl = process.env.MONARCH_API_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("MONARCH_API_BASE_URL is not configured");
  const token = process.env.BRAND_PIVOT_API_TOKEN;
  if (!token) throw new Error("BRAND_PIVOT_API_TOKEN is not configured");

  let response: Response;
  try {
    const url = new URL(`${baseUrl}/api/inventory/brand-pivot`);
    url.searchParams.set("period", period);
    url.searchParams.set("current_snapshot", endDate);
    url.searchParams.set("previous_snapshot", startDate);
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Monarch Brand × Kỳ API timed out after 2 minutes");
    }
    throw new Error(`Could not reach Monarch Brand × Kỳ API: ${error instanceof Error ? error.message : String(error)}`);
  }

  const payload = await response.json().catch(() => null) as BrandPivotApiResponse | null;
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "message" in payload
      ? String(payload.message)
      : payload && typeof payload === "object" && "missing_snapshots" in payload
        ? `Missing snapshots: ${JSON.stringify(payload.missing_snapshots)}`
        : "no error details returned";
    throw new Error(`Monarch Brand × Kỳ API returned HTTP ${response.status}: ${detail}`);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Monarch Brand × Kỳ API returned invalid JSON");
  }
  if (payload.warning) {
    throw new Error(`Monarch Brand × Kỳ API warning: ${String(payload.warning)}`);
  }
  if (payload.current_snapshot !== endDate || payload.previous_snapshot !== startDate) {
    throw new Error(
      `Monarch returned snapshots ${String(payload.current_snapshot)} and ${String(payload.previous_snapshot)}; expected ${endDate} and ${startDate}`,
    );
  }
  if (!Array.isArray(payload.rows)) {
    throw new Error("Monarch Brand × Kỳ API response is missing rows");
  }

  const valuesByBrand = new Map<string, { current: number; previous: number }>();
  for (const value of payload.rows) {
    if (!value || typeof value !== "object") throw new Error("Monarch returned an invalid brand row");
    const row = value as { brand?: unknown; current_value?: unknown; previous_value?: unknown };
    if (typeof row.brand !== "string" || !row.brand.trim()) {
      throw new Error("Monarch returned a brand row without a brand name");
    }
    const current = Number(row.current_value);
    const previous = Number(row.previous_value);
    if (!Number.isFinite(current) || !Number.isFinite(previous)) {
      throw new Error(`Monarch returned invalid values for brand ${row.brand}`);
    }
    const brandValues = valuesByBrand.get(row.brand) ?? { current: 0, previous: 0 };
    brandValues.current += current;
    brandValues.previous += previous;
    valuesByBrand.set(row.brand, brandValues);
  }

  const rows = Array.from(valuesByBrand, ([brand, values]) => {
    const delta_value = values.current - values.previous;
    return {
      brand,
      current_value: values.current,
      previous_value: values.previous,
      delta_value,
      delta_percent: percentChange(values.current, values.previous),
    };
  }).sort((a, b) => a.brand.localeCompare(b.brand));
  const current_value = rows.reduce((sum, row) => sum + row.current_value, 0);
  const previous_value = rows.reduce((sum, row) => sum + row.previous_value, 0);
  const delta_value = current_value - previous_value;
  return {
    current_snapshot: endDate,
    previous_snapshot: startDate,
    period,
    rows,
    total: {
      current_value,
      previous_value,
      delta_value,
      delta_percent: percentChange(current_value, previous_value),
    },
  };
}

/** Compare the latest two calendar Sundays in the Vietnam timezone. */
export async function getWeeklyBrandInventoryData(): Promise<BrandInventoryComparison> {
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = Number(dateParts.find((part) => part.type === "year")?.value);
  const month = Number(dateParts.find((part) => part.type === "month")?.value);
  const day = Number(dateParts.find((part) => part.type === "day")?.value);
  const currentSunday = new Date(Date.UTC(year, month - 1, day));
  currentSunday.setUTCDate(currentSunday.getUTCDate() - currentSunday.getUTCDay());
  const previousSunday = new Date(currentSunday);
  previousSunday.setUTCDate(previousSunday.getUTCDate() - 7);
  const toDateString = (date: Date) => date.toISOString().slice(0, 10);

  return getBrandInventoryData(
    toDateString(previousSunday),
    toDateString(currentSunday),
    "week",
  );
}
