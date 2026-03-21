/**
 * Shared output formatting utilities for CLI commands.
 *
 * Provides consistent json | table | sarif output across all commands.
 */

import {
  createSarifLog,
  createSarifRun,
  createSarifResult,
} from "@mma/core";
import type { SarifLevel } from "@mma/core";

export type OutputFormat = "json" | "table" | "sarif";
export type ReportFormat = OutputFormat | "markdown" | "both";

const VALID_FORMATS = new Set<string>(["json", "table", "sarif"]);
const VALID_REPORT_FORMATS = new Set<string>(["json", "table", "sarif", "markdown", "both"]);

/** Validate a format string from CLI args. Exits with error if invalid. */
export function validateFormat(format: string | undefined, defaultFormat: OutputFormat): OutputFormat {
  if (!format) return defaultFormat;
  if (VALID_FORMATS.has(format)) return format as OutputFormat;
  console.error(`Invalid format: "${format}". Must be one of: json, table, sarif`);
  process.exit(1);
}

/** Validate a report format string. Accepts all OutputFormat values plus markdown and both. */
export function validateReportFormat(format: string | undefined, defaultFormat: ReportFormat): ReportFormat {
  if (!format) return defaultFormat;
  if (VALID_REPORT_FORMATS.has(format)) return format as ReportFormat;
  console.error(`Invalid format: "${format}". Must be one of: json, table, sarif, markdown, both`);
  process.exit(1);
}

/** Emit `data` as pretty-printed JSON to stdout. */
export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Format a padded-column table as a string.
 *
 * Each column is sized to the widest value (header or cell) plus 2 spaces.
 * Returns the formatted table without a trailing newline.
 */
export function formatTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      const cell = row[i] ?? "";
      if (cell.length > max) max = cell.length;
    }
    return max;
  });

  const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - s.length));

  const lines: string[] = [];
  lines.push(headers.map((h, i) => pad(h, colWidths[i]!)).join("  "));
  lines.push(colWidths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    lines.push(row.map((c, i) => pad(c, colWidths[i]!)).join("  "));
  }
  return lines.join("\n");
}

/**
 * Emit a padded-column table to stdout.
 *
 * Each column is sized to the widest value (header or cell) plus 2 spaces.
 */
export function printTable(headers: string[], rows: string[][]): void {
  console.log(formatTable(headers, rows));
}

/** Wrap results in a SARIF v2.1.0 log and emit to stdout. */
export function printSarif(
  toolName: string,
  results: ReadonlyArray<{
    ruleId: string;
    level: SarifLevel;
    message: string;
    repo?: string;
    properties?: Record<string, unknown>;
  }>,
): void {
  const sarifResults = results.map((r) =>
    createSarifResult(r.ruleId, r.level, r.message, {
      locations: r.repo
        ? [{ logicalLocations: [{ name: r.repo, kind: "module", properties: { repo: r.repo } }] }]
        : undefined,
      properties: r.properties,
    }),
  );

  const ruleIds = [...new Set(results.map((r) => r.ruleId))];
  const rules = ruleIds.map((id) => ({
    id,
    shortDescription: { text: id },
  }));

  const log = createSarifLog([
    createSarifRun(toolName, "0.1.0", rules, sarifResults),
  ]);

  console.log(JSON.stringify(log, null, 2));
}
