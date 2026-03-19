/**
 * `mma baseline` — Known-violations baseline management.
 *
 * Subcommands:
 *   create  Snapshot current SARIF findings as a baseline file
 *   check   Compare current findings against baseline; exit 1 if new violations
 */

import { readFile, writeFile } from "node:fs/promises";
import type { SarifLog, SarifResult } from "@mma/core";
import type { KVStore } from "@mma/storage";
import { fingerprint } from "@mma/diagnostics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BaselineFile {
  readonly version: 1;
  readonly created: string;
  readonly tool: "mma";
  readonly totalFindings: number;
  readonly fingerprints: readonly string[];
}

export interface BaselineCreateOptions {
  readonly kvStore: KVStore;
  readonly output: string;
}

export interface BaselineCheckOptions {
  readonly kvStore: KVStore;
  readonly baselinePath: string;
}

export interface BaselineCheckResult {
  readonly totalCurrent: number;
  readonly totalBaseline: number;
  readonly newFindings: SarifResult[];
  readonly absentFindings: number;
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function baselineCreateCommand(
  options: BaselineCreateOptions,
): Promise<{ count: number }> {
  const sarifJson = await options.kvStore.get("sarif:latest");
  const results = loadSarifResults(sarifJson);

  const fps = results.map((r) => fingerprint(r));

  const baseline: BaselineFile = {
    version: 1,
    created: new Date().toISOString(),
    tool: "mma",
    totalFindings: fps.length,
    fingerprints: fps,
  };

  await writeFile(options.output, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
  console.log(`Baseline created: ${fps.length} finding(s) written to ${options.output}`);
  return { count: fps.length };
}

export async function baselineCheckCommand(
  options: BaselineCheckOptions,
): Promise<BaselineCheckResult> {
  // Load current findings
  const sarifJson = await options.kvStore.get("sarif:latest");
  const currentResults = loadSarifResults(sarifJson);

  // Load baseline file
  let baseline: BaselineFile;
  try {
    const raw = await readFile(options.baselinePath, "utf-8");
    baseline = JSON.parse(raw) as BaselineFile;
  } catch (err) {
    throw new Error(
      `Could not read baseline file: ${options.baselinePath} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (baseline.version !== 1) {
    throw new Error(`Unsupported baseline version: ${String((baseline as { version: unknown }).version)}`);
  }

  const baselineSet = new Set(baseline.fingerprints);
  const currentFps = currentResults.map((r) => fingerprint(r));

  // Detect new findings (in current but not in baseline)
  const newFindings: SarifResult[] = [];
  const currentSet = new Set<string>();
  for (let i = 0; i < currentResults.length; i++) {
    const fp = currentFps[i]!;
    currentSet.add(fp);
    if (!baselineSet.has(fp)) {
      newFindings.push(currentResults[i]!);
    }
  }

  // Count absent findings (in baseline but not in current)
  let absentFindings = 0;
  for (const fp of baseline.fingerprints) {
    if (!currentSet.has(fp)) {
      absentFindings++;
    }
  }

  return {
    totalCurrent: currentResults.length,
    totalBaseline: baseline.totalFindings,
    newFindings,
    absentFindings,
  };
}
