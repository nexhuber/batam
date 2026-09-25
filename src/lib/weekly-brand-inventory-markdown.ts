import type { WeeklyBrandInventoryComparison } from "@/lib/weekly-brand-inventory";

/** Format the Sunday inventory comparison as a Markdown table. */
export function formatWeeklyBrandInventoryComparisonMarkdown(
  report: WeeklyBrandInventoryComparison,
): string {
  const number = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
  const lines = [
    "### Giá trị tồn kho theo Brand",
    "",
    `Kỳ này: **${report.current_snapshot}** · Kỳ trước: **${report.previous_snapshot}**`,
    "",
    "| Brand | Kỳ này (VND) | Kỳ trước (VND) | Tăng/Giảm |",
    "| :--- | ---: | ---: | ---: |",
  ];
  const tableRows = [...report.rows, { brand: "Grand Total", ...report.total }];
  for (const [index, row] of tableRows.entries()) {
    const brand = row.brand.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
    const delta = row.delta_value === 0
      ? "—"
      : `${row.delta_value > 0 ? "+" : ""}${number.format(row.delta_value)} (${row.delta_percent === null ? "new" : `${row.delta_percent.toFixed(1)}%`})`;
    const cells = [brand, number.format(row.current_value), number.format(row.previous_value), delta];
    const content = index === tableRows.length - 1
      ? cells.map((cell) => `**${cell}**`).join(" | ")
      : cells.join(" | ");
    lines.push(`| ${content} |`);
  }
  return lines.join("\n");
}
