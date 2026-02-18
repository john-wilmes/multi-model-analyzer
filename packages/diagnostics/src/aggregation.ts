/**
 * SARIF aggregation: combine per-component SARIF into single report.
 *
 * Merges runs from multiple analysis components (config, fault, functional)
 * into a single SARIF log with combined statistics.
 */

import type { SarifLog, SarifRun, SarifStatistics } from "@mma/core";
import { createSarifLog } from "@mma/core";

export function aggregateSarifLogs(
  logs: readonly SarifLog[],
): SarifLog {
  const allRuns: SarifRun[] = [];
  for (const log of logs) {
    allRuns.push(...log.runs);
  }
  return createSarifLog(allRuns);
}

export function aggregateRuns(
  runs: readonly SarifRun[],
  toolName: string,
  toolVersion: string,
): SarifRun {
  const allResults = runs.flatMap((r) => r.results);
  const allRules = deduplicateRules(runs.flatMap((r) => r.tool.driver.rules));
  const allLogicalLocations = deduplicateLocations(
    runs.flatMap((r) => r.logicalLocations ?? []),
  );

  const stats = computeAggregateStatistics(runs);

  return {
    tool: {
      driver: {
        name: toolName,
        version: toolVersion,
        rules: allRules,
      },
    },
    results: allResults,
    logicalLocations: allLogicalLocations.length > 0 ? allLogicalLocations : undefined,
    properties: { statistics: stats },
  };
}

function deduplicateRules(
  rules: readonly import("@mma/core").SarifReportingDescriptor[],
): import("@mma/core").SarifReportingDescriptor[] {
  const seen = new Map<string, import("@mma/core").SarifReportingDescriptor>();
  for (const rule of rules) {
    if (!seen.has(rule.id)) {
      seen.set(rule.id, rule);
    }
  }
  return [...seen.values()];
}

function deduplicateLocations(
  locations: readonly import("@mma/core").SarifLogicalLocation[],
): import("@mma/core").SarifLogicalLocation[] {
  const seen = new Map<string, import("@mma/core").SarifLogicalLocation>();
  for (const loc of locations) {
    const key = loc.fullyQualifiedName ?? loc.name ?? JSON.stringify(loc);
    if (!seen.has(key)) {
      seen.set(key, loc);
    }
  }
  return [...seen.values()];
}

function computeAggregateStatistics(
  runs: readonly SarifRun[],
): SarifStatistics {
  let totalResults = 0;
  let errorCount = 0;
  let warningCount = 0;
  let noteCount = 0;
  const allRules = new Set<string>();

  for (const run of runs) {
    const stats = run.properties?.statistics;
    if (stats) {
      totalResults += stats.totalResults;
      errorCount += stats.errorCount;
      warningCount += stats.warningCount;
      noteCount += stats.noteCount;
    } else {
      // Compute from results
      for (const result of run.results) {
        totalResults++;
        allRules.add(result.ruleId);
        switch (result.level) {
          case "error":
            errorCount++;
            break;
          case "warning":
            warningCount++;
            break;
          case "note":
            noteCount++;
            break;
        }
      }
    }
  }

  return {
    totalResults,
    errorCount,
    warningCount,
    noteCount,
    rulesTriggered: allRules.size,
    analysisTimestamp: new Date().toISOString(),
  };
}

export function sarifToJson(log: SarifLog, pretty: boolean = true): string {
  return JSON.stringify(log, null, pretty ? 2 : undefined);
}
