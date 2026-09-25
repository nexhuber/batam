import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/bigquery", () => ({ bigQuery: () => ({ query }) }));

import { getLatestSundayBrandInventoryComparison } from "@/lib/weekly-brand-inventory";
import { formatWeeklyBrandInventoryComparisonMarkdown } from "@/lib/weekly-brand-inventory-markdown";

describe("Sunday Brand inventory report in Batam", () => {
  let temporaryDir: string;
  const originalProject = process.env.BQ_PROJECT;
  const originalPortfolioFile = process.env.BATAM_PORTFOLIO_FILE;

  beforeAll(() => {
    temporaryDir = mkdtempSync(join(tmpdir(), "batam-inventory-test-"));
    const header = Array<unknown>(44).fill(null);
    header[0] = "SKU_ID/ Barcode";
    header[1] = "Brand";
    header[43] = "Lẻ\n+VAT";
    const items: Array<[string, string, number]> = [
      ["a", "Javel", 100],
      ["b", "LIXCO", 20],
      ["c", "Becoming", 10],
      ["new", "New Brand", 50],
    ];
    const rows = items.map(([barcode, brand, cost]) => {
      const row = Array<unknown>(44).fill(null);
      row[0] = barcode;
      row[1] = brand;
      row[43] = cost;
      return row;
    });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[], [], [], header, ...rows]), "I. SKU lẻ unique");
    XLSX.writeFile(workbook, join(temporaryDir, "portfolio.xlsx"));
  });

  afterAll(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
    if (originalProject === undefined) delete process.env.BQ_PROJECT;
    else process.env.BQ_PROJECT = originalProject;
    if (originalPortfolioFile === undefined) delete process.env.BATAM_PORTFOLIO_FILE;
    else process.env.BATAM_PORTFOLIO_FILE = originalPortfolioFile;
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T18:00:00Z")); // Thursday in Vietnam
    process.env.BQ_PROJECT = "nexhub-data-platform";
    process.env.BATAM_PORTFOLIO_FILE = join(temporaryDir, "portfolio.xlsx");
  });

  afterEach(() => vi.useRealTimers());

  it("calculates both snapshots and renders their Markdown table", async () => {
    query.mockResolvedValue([[ 
      { snapshot_date: "2026-09-20", barcode: "a", total_qty: 2 },
      { snapshot_date: "2026-09-20", barcode: "b", total_qty: 3 },
      { snapshot_date: "2026-09-20", barcode: "c", total_qty: 1 },
      { snapshot_date: "2026-09-20", barcode: "new", total_qty: 1 },
      { snapshot_date: "2026-09-13", barcode: "a", total_qty: 1 },
      { snapshot_date: "2026-09-13", barcode: "b", total_qty: 4 },
      { snapshot_date: "2026-09-13", barcode: "c", total_qty: 1 },
    ]]);

    const data = await getLatestSundayBrandInventoryComparison();
    const markdown = formatWeeklyBrandInventoryComparisonMarkdown(data);

    expect([data.current_snapshot, data.previous_snapshot]).toEqual(["2026-09-20", "2026-09-13"]);
    expect(data.rows).toEqual(expect.arrayContaining([
      { brand: "LIXCO", current_value: 260, previous_value: 180, delta_value: 80,
        delta_percent: 80 / 180 * 100 },
      { brand: "Colorkey", current_value: 10, previous_value: 10, delta_value: 0,
        delta_percent: 0 },
      { brand: "New Brand", current_value: 50, previous_value: 0, delta_value: 50,
        delta_percent: null },
    ]));
    expect(data.total).toEqual({ current_value: 320, previous_value: 190, delta_value: 130,
      delta_percent: 130 / 190 * 100 });
    expect(markdown).toContain("| LIXCO | 260 | 180 | +80 (44.4%) |");
    expect(markdown).toContain("| Colorkey | 10 | 10 | — |");
    expect(markdown).toContain("| New Brand | 50 | 0 | +50 (new) |");
    expect(markdown).toContain("| **Grand Total** | **320** | **190** | **+130 (68.4%)** |");
    const sql = query.mock.calls[0][0].query as string;
    expect(sql).toContain("GROUP BY nh_sku");
    expect(sql).toContain("i.status_display != 'Deleted'");
    expect(sql).toContain("i.qty_physical > 0");
  });

  it("uses the current day when it is Sunday in Vietnam", async () => {
    vi.setSystemTime(new Date("2026-09-26T17:00:00Z"));
    query.mockResolvedValue([[ 
      { snapshot_date: "2026-09-27", barcode: null, total_qty: 1 },
      { snapshot_date: "2026-09-20", barcode: null, total_qty: 1 },
    ]]);

    const data = await getLatestSundayBrandInventoryComparison();
    expect([data.current_snapshot, data.previous_snapshot]).toEqual(["2026-09-27", "2026-09-20"]);
  });

  it("names a missing Sunday instead of substituting another snapshot", async () => {
    query.mockResolvedValue([[{ snapshot_date: "2026-09-20", barcode: "a", total_qty: 1 }]]);
    await expect(getLatestSundayBrandInventoryComparison()).rejects.toThrow("2026-09-13");
  });

  it("reports an unavailable Portfolio file", async () => {
    query.mockResolvedValue([[ 
      { snapshot_date: "2026-09-20", barcode: "a", total_qty: 1 },
      { snapshot_date: "2026-09-13", barcode: "a", total_qty: 1 },
    ]]);
    process.env.BATAM_PORTFOLIO_FILE = join(temporaryDir, "missing.xlsx");
    await expect(getLatestSundayBrandInventoryComparison()).rejects.toThrow("BATAM_PORTFOLIO_FILE");
  });
});
