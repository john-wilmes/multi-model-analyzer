/**
 * `mma practices` — Generate a prioritized best-practices report.
 *
 * Reads SARIF findings and metrics from a KVStore and produces an actionable
 * report with prioritized findings, structural health, and recommendations.
 * Output is for the repo owner; real repo names are used (not anonymized).
 */

import type { SarifLog, SarifResult } from "@mma/core";
import { discoverRepos } from "@mma/storage";

export type {
  PracticesOptions,
  PracticesReport,
  DebtEstimate,
  DebtCategoryEstimate,
  DebtRuleEstimate,
  ExecutiveSummary,
  PrioritizedFindings,
  FindingGroup,
  StructuralHealth,
  RepoHealthEntry,
  CategoryScorecard,
  CategoryRow,
  Recommendation,
  AtdiScore,
  AtdiCategoryBreakdown,
} from "./practices/index.js";

export { renderPracticesMarkdown, renderPracticesTable } from "./practices/index.js";

import type { PracticesOptions, PracticesReport, PrioritizedFindings } from "./practices/index.js";
import {
  assessStructuralHealth,
  buildExecutiveSummary,
  buildScorecard,
  computeAtdi,
  computeDebtEstimate,
  prioritizeFindings,
  synthesizeRecommendations,
  renderPracticesMarkdown,
  renderPracticesTable,
} from "./practices/index.js";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function practicesCommand(
  options: PracticesOptions,
): Promise<PracticesReport> {
  const { kvStore, format, output, topN } = options;

  // Read sarif:latest
  const sarifJson = await kvStore.get("sarif:latest");
  let results: SarifResult[] = [];
  if (sarifJson) {
    try {
      const log = JSON.parse(sarifJson) as SarifLog;
      results = [...(log.runs[0]?.results ?? [])];
    } catch {
      // Malformed sarif:latest — skip rather than aborting the entire command.
    }
  }

  // Discover repos
  const repos = await discoverRepos(kvStore);

  // Build sections
  const structural = await assessStructuralHealth(kvStore, repos);
  const findings = prioritizeFindings(results);
  const scorecard = buildScorecard(results);

  const atdi = computeAtdi(results, structural);

  // Executive summary derives grade from ATDI (which normalizes by module count)
  const rawExec = buildExecutiveSummary(atdi.score);
  const topActionSource =
    findings.fixNow.length > 0 ? findings.fixNow : findings.planFor;
  const topActions = topActionSource.slice(0, 3).map((g) => g.action);
  const executive = { ...rawExec, topActions };

  const recommendations = synthesizeRecommendations(findings, structural);
  const debt = computeDebtEstimate(results);

  // Apply topN to fixNow tier if requested
  const cappedFindings: PrioritizedFindings =
    topN !== undefined
      ? {
          fixNow: findings.fixNow.slice(0, topN),
          planFor: findings.planFor.slice(0, topN),
          monitor: findings.monitor.slice(0, topN),
        }
      : findings;

  const report: PracticesReport = {
    schemaVersion: "1.2",
    generatedAt: new Date().toISOString(),
    repoCount: repos.length,
    executive,
    findings: cappedFindings,
    structural,
    scorecard,
    recommendations,
    atdi,
    debt,
  };

  // Render
  let rendered: string;
  if (format === "json") {
    rendered = JSON.stringify(report, null, 2);
  } else if (format === "table") {
    rendered = renderPracticesTable(report);
  } else {
    // markdown (default), "both", "sarif" → use markdown
    rendered = renderPracticesMarkdown(report);
  }

  if (output) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(output, rendered + "\n", "utf-8");
    console.error(`Wrote practices report to ${output}`);
  } else if (!options.silent) {
    console.log(rendered);
  }

  return report;
}
