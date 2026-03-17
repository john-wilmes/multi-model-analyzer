/**
 * `mma delta` — PR delta analysis.
 *
 * Filters SARIF findings to only those affecting files changed in a git
 * revision range, showing new/updated findings for PR review or CI gating.
 *
 * Usage:
 *   mma delta <range> [-c config.json] [--db path] [--format markdown|json|sarif] [--exit-code]
 */

import type { KVStore } from "@mma/storage";
import type { SarifLog, SarifResult, SarifBaselineState } from "@mma/core";
import { createSarifLog, createSarifRun } from "@mma/core";
import { getChangedFilesInRange, parseRevisionRange } from "@mma/ingestion";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DeltaFormat = "markdown" | "json" | "sarif";

export interface RepoConfig {
  readonly name: string;
  readonly localPath: string;
}

export interface DeltaOptions {
  readonly kvStore: KVStore;
  readonly repos: readonly RepoConfig[];
  readonly range: string;
  readonly format: DeltaFormat;
  readonly silent?: boolean;
}

export interface DeltaResult {
  readonly range: string;
  readonly changedFiles: number;
  readonly addedFiles: number;
  readonly modifiedFiles: number;
  readonly newFindings: SarifResult[];
  readonly updatedFindings: SarifResult[];
  readonly unchangedCount: number;
  /** True when there are new or updated findings (for CI exit-code use). */
  readonly hasNewOrUpdated: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadSarifResults(sarifJson: string | undefined): SarifResult[] {
  if (!sarifJson) return [];
  try {
    const log = JSON.parse(sarifJson) as SarifLog;
    return [...(log.runs?.[0]?.results ?? [])];
  } catch {
    return [];
  }
}

/**
 * Check if a SARIF result touches any of the provided file paths.
 *
 * SARIF logicalLocations.fullyQualifiedName may be like "repo-name/src/auth.ts"
 * while the changed file path is "src/auth.ts". Use substring matching so
 * both relative and repo-prefixed paths match.
 */
function resultTouchesChangedFiles(
  result: SarifResult,
  changedPaths: Set<string>,
): boolean {
  const locations = result.locations ?? [];
  for (const loc of locations) {
    const logicalLocs = loc.logicalLocations ?? [];
    for (const ll of logicalLocs) {
      const fqn = ll.fullyQualifiedName;
      if (!fqn) continue;
      // Direct match
      if (changedPaths.has(fqn)) return true;
      // Substring match: changedPath is a suffix of fqn (e.g. fqn = "repo/src/auth.ts", path = "src/auth.ts")
      for (const path of changedPaths) {
        if (fqn.endsWith(path) || path.endsWith(fqn)) return true;
        // Also handle path separator boundary
        if (fqn.includes(`/${path}`)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function levelLabel(level: string): string {
  return level;
}

function firstFqn(result: SarifResult): string {
  for (const loc of result.locations ?? []) {
    for (const ll of loc.logicalLocations ?? []) {
      if (ll.fullyQualifiedName) return ll.fullyQualifiedName;
    }
  }
  return "";
}

export function renderDeltaMarkdown(result: DeltaResult, range: string): string {
  const lines: string[] = [];
  const push = (...s: string[]) => lines.push(...s);

  push("## MMA Delta Analysis", "");
  push(`**Range:** \`${range}\``);
  push(
    `**Changed files:** ${result.changedFiles} (${result.modifiedFiles} modified, ${result.addedFiles} added)`,
  );
  push(
    `**New findings:** ${result.newFindings.length} | **Updated:** ${result.updatedFindings.length} | **Unchanged:** ${result.unchangedCount} (hidden)`,
  );
  push("");

  if (result.newFindings.length === 0 && result.updatedFindings.length === 0) {
    push("No new or worsened findings.");
    return lines.join("\n");
  }

  if (result.newFindings.length > 0) {
    push("### New Findings", "");
    push("| Severity | Rule | Message | File |");
    push("|----------|------|---------|------|");
    for (const f of result.newFindings) {
      const severity = levelLabel(f.level);
      const rule = f.ruleId;
      const msg = (f.message?.text ?? "").replace(/\|/g, "\\|");
      const file = firstFqn(f);
      push(`| ${severity} | ${rule} | ${msg} | ${file} |`);
    }
    push("");
  }

  if (result.updatedFindings.length > 0) {
    push("### Updated Findings", "");
    push("| Severity | Rule | Message | File |");
    push("|----------|------|---------|------|");
    for (const f of result.updatedFindings) {
      const severity = levelLabel(f.level);
      const rule = f.ruleId;
      const msg = (f.message?.text ?? "").replace(/\|/g, "\\|");
      const file = firstFqn(f);
      push(`| ${severity} | ${rule} | ${msg} | ${file} |`);
    }
    push("");
  }

  return lines.join("\n");
}

export function renderDeltaJson(
  newFindings: SarifResult[],
  updatedFindings: SarifResult[],
): string {
  const all = [
    ...newFindings.map((r) => ({ ...r, baselineState: "new" as SarifBaselineState })),
    ...updatedFindings.map((r) => ({ ...r, baselineState: "updated" as SarifBaselineState })),
  ];
  return JSON.stringify(all, null, 2);
}

export function renderDeltaSarif(
  newFindings: SarifResult[],
  updatedFindings: SarifResult[],
  range: string,
): string {
  const allResults = [...newFindings, ...updatedFindings];
  const ruleIds = [...new Set(allResults.map((r) => r.ruleId))];
  const rules = ruleIds.map((id) => ({
    id,
    shortDescription: { text: id },
  }));
  const log = createSarifLog([
    createSarifRun("mma-delta", "0.1.0", rules, allResults, {
      properties: { range },
    }),
  ]);
  return JSON.stringify(log, null, 2);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function deltaCommand(options: DeltaOptions): Promise<DeltaResult> {
  const { kvStore, repos, range, format, silent } = options;

  // Load sarif:latest
  const sarifJson = await kvStore.get("sarif:latest");
  if (!sarifJson) {
    const msg = "No SARIF data found. Run 'mma index' first to build the analysis database.";
    if (!silent) console.log(msg);
    const empty: DeltaResult = {
      range,
      changedFiles: 0,
      addedFiles: 0,
      modifiedFiles: 0,
      newFindings: [],
      updatedFindings: [],
      unchangedCount: 0,
      hasNewOrUpdated: false,
    };
    return empty;
  }

  const allResults = loadSarifResults(sarifJson);

  // Collect changed files across all repos
  const parsedRange = parseRevisionRange(range);
  const changedPathSet = new Set<string>();
  let totalAdded = 0;
  let totalModified = 0;

  for (const repo of repos) {
    try {
      const diff = await getChangedFilesInRange(repo.localPath, range);
      for (const f of diff.added) changedPathSet.add(f);
      for (const f of diff.modified) changedPathSet.add(f);
      totalAdded += diff.added.length;
      totalModified += diff.modified.length;
    } catch (err) {
      // Bare repos or repos that don't have the range — skip with warning
      const detail = err instanceof Error ? err.message : String(err);
      if (!silent) {
        console.error(
          `warning: skipping repo "${repo.name}" — could not diff range "${range}": ${detail}`,
        );
      }
    }
  }

  // Filter results to changed files only
  const touchingChanged = allResults.filter((r) =>
    resultTouchesChangedFiles(r, changedPathSet),
  );

  // Split by baselineState
  const newFindings: SarifResult[] = [];
  const updatedFindings: SarifResult[] = [];
  let unchangedCount = 0;

  for (const r of touchingChanged) {
    if (r.baselineState === "new") {
      newFindings.push(r);
    } else if (r.baselineState === "updated") {
      updatedFindings.push(r);
    } else {
      unchangedCount++;
    }
  }

  const result: DeltaResult = {
    range: `${parsedRange.from}..${parsedRange.to}`,
    changedFiles: changedPathSet.size,
    addedFiles: totalAdded,
    modifiedFiles: totalModified,
    newFindings,
    updatedFindings,
    unchangedCount,
    hasNewOrUpdated: newFindings.length > 0 || updatedFindings.length > 0,
  };

  if (!silent) {
    let rendered: string;
    if (format === "json") {
      rendered = renderDeltaJson(newFindings, updatedFindings);
    } else if (format === "sarif") {
      rendered = renderDeltaSarif(newFindings, updatedFindings, range);
    } else {
      rendered = renderDeltaMarkdown(result, range);
    }
    console.log(rendered);
  }

  return result;
}
