import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import * as XLSX from "xlsx";
import { bigQuery } from "@/lib/bigquery";

export type BrandInventoryValue = {
  brand: string;
  current_value: number;
  previous_value: number;
  delta_value: number;
  delta_percent: number | null;
};

export type WeeklyBrandInventoryComparison = {
  current_snapshot: string;
  previous_snapshot: string;
  rows: BrandInventoryValue[];
  total: Omit<BrandInventoryValue, "brand">;
};

/** Compare the two latest calendar Sundays in Vietnam using Onflow inventory and Portfolio costs. */
export async function getLatestSundayBrandInventoryComparison(): Promise<WeeklyBrandInventoryComparison> {
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = Number(dateParts.find((part) => part.type === "year")?.value);
  const month = Number(dateParts.find((part) => part.type === "month")?.value);
  const day = Number(dateParts.find((part) => part.type === "day")?.value);
  const today = Date.UTC(year, month - 1, day);
  const sunday = today - new Date(today).getUTCDay() * 86_400_000;
  const current_snapshot = new Date(sunday).toISOString().slice(0, 10);
  const previous_snapshot = new Date(sunday - 7 * 86_400_000).toISOString().slice(0, 10);

  const project = process.env.BQ_PROJECT;
  if (!project) throw new Error("BQ_PROJECT is not configured");
  const [inventoryRows] = await bigQuery().query({
    query: `WITH deduped_mapping AS (
        SELECT nh_sku, ANY_VALUE(barcode) AS barcode
        FROM \`${project}.haravan_dwh.onflow_code_mapping\`
        WHERE nh_sku IS NOT NULL AND barcode IS NOT NULL
        GROUP BY nh_sku
      )
      SELECT FORMAT_DATE('%F', CAST(i.snapshot_date AS DATE)) AS snapshot_date,
             m.barcode,
             SUM(i.qty_physical) AS total_qty
      FROM \`${project}.haravan_dwh.noworry_onflow_inventory_full\` i
      LEFT JOIN deduped_mapping m ON m.nh_sku = i.sku
      WHERE CAST(i.snapshot_date AS DATE) IN (
        CAST(@current_snapshot AS DATE), CAST(@previous_snapshot AS DATE)
      )
        AND i.status_display != 'Deleted'
        AND i.qty_physical > 0
      GROUP BY snapshot_date, m.barcode`,
    params: { current_snapshot, previous_snapshot },
    location: process.env.BQ_LOCATION || "asia-southeast1",
  });
  const quantities = inventoryRows as Array<{
    snapshot_date: string;
    barcode: string | null;
    total_qty: number | string | null;
  }>;
  const presentDates = new Set(quantities.map((row) => row.snapshot_date));
  const missingDates = [current_snapshot, previous_snapshot].filter((date) => !presentDates.has(date));
  if (missingDates.length) {
    throw new Error(`Missing valid Onflow inventory snapshot for Sunday: ${missingDates.join(", ")}`);
  }

  const portfolioPath = process.env.BATAM_PORTFOLIO_FILE;
  if (!portfolioPath || !isAbsolute(portfolioPath) || !existsSync(portfolioPath)) {
    throw new Error("BATAM_PORTFOLIO_FILE must point to a readable absolute path to portfolio-quan-tri-gia.xlsx");
  }
  const workbook = XLSX.read(readFileSync(portfolioPath), { type: "buffer" });
  const sheet = workbook.Sheets["I. SKU lẻ unique"];
  if (!sheet) throw new Error('Portfolio sheet "I. SKU lẻ unique" is missing');
  const headers = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: true,
    range: { s: { c: 0, r: 3 }, e: { c: 50, r: 3 } },
  })[0] ?? [];
  let barcodeIndex = -1;
  let brandIndex = -1;
  for (const [index, header] of headers.entries()) {
    const name = String(header ?? "").replace(/\s+/g, " ").trim();
    if (name === "SKU_ID/ Barcode") barcodeIndex = index;
    if (name === "Brand") brandIndex = index;
  }
  if (barcodeIndex < 0 || brandIndex < 0 || headers.length <= 43) {
    throw new Error("Portfolio is missing barcode, Brand, or cost column 44");
  }
  const portfolioByBarcode = new Map<string, { brand: string; cost: number }>();
  const excelRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: true,
    range: 4,
  });
  for (const row of excelRows) {
    const barcode = String(row[barcodeIndex] ?? "").trim();
    if (!barcode) continue;
    const brand = String(row[brandIndex] ?? "").trim();
    const costRaw = row[43]; // Same +VAT unit-cost column used by Monarch.
    const cost = typeof costRaw === "number"
      ? costRaw
      : Number.parseFloat(String(costRaw ?? "").trim().replace(/,/g, "").replace(/%$/, ""));
    portfolioByBarcode.set(barcode, { brand, cost: Number.isFinite(cost) ? cost : 0 });
  }

  const brandMapping: Record<string, string> = {
    javel: "LIXCO", on1: "LIXCO", lix: "LIXCO", "siêu sạch": "LIXCO", sieusach: "LIXCO",
    siracha: "Ông Chà Và", sriracha: "Ông Chà Và", "ong cha va": "Ông Chà Và",
    "ông chà và": "Ông Chà Và", "gu trội": "Ông Chà Và", gutroi: "Ông Chà Và",
    pavoni: "Ông Chà Và", okenki: "Ông Chà Và", becoming: "Colorkey",
  };
  const valuesByBrand = new Map<string, { current: number; previous: number }>();
  for (const row of quantities) {
    if (!row.barcode) continue;
    const portfolio = portfolioByBarcode.get(row.barcode);
    const quantity = Number(row.total_qty);
    if (!portfolio?.brand || portfolio.cost <= 0 || !Number.isFinite(quantity) || quantity <= 0) continue;
    const brand = brandMapping[portfolio.brand.toLowerCase()] ?? portfolio.brand;
    const values = valuesByBrand.get(brand) ?? { current: 0, previous: 0 };
    if (row.snapshot_date === current_snapshot) values.current += quantity * portfolio.cost;
    else values.previous += quantity * portfolio.cost;
    valuesByBrand.set(brand, values);
  }

  const rows = Array.from(valuesByBrand, ([brand, values]) => {
    const delta_value = values.current - values.previous;
    return {
      brand,
      current_value: values.current,
      previous_value: values.previous,
      delta_value,
      delta_percent: values.previous > 0 ? delta_value / values.previous * 100 : null,
    };
  }).sort((a, b) => a.brand.localeCompare(b.brand));
  const current_value = rows.reduce((sum, row) => sum + row.current_value, 0);
  const previous_value = rows.reduce((sum, row) => sum + row.previous_value, 0);
  const delta_value = current_value - previous_value;
  return {
    current_snapshot,
    previous_snapshot,
    rows,
    total: {
      current_value,
      previous_value,
      delta_value,
      delta_percent: previous_value > 0 ? delta_value / previous_value * 100 : null,
    },
  };
}
