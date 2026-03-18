/**
 * SARIF conversion for hotspot findings.
 *
 * Rule ID: hotspot/high-churn-complexity
 * Severity thresholds (relative to 0-100 normalised score):
 *   score >= threshold        → "warning"
 *   score >= threshold * 0.5 → "note"
 *   otherwise                 → not reported
 */

import type { SarifResult } from "@mma/core";

/** Minimal shape needed from a hotspot entry — mirrors FileHotspot in @mma/heuristics */
export interface HotspotEntry {
  readonly filePath: string;
  readonly churn: number;
  readonly symbolCount: number;
  readonly hotspotScore: number;
}

/**
 * Convert hotspot results to SARIF findings.
 *
 * @param hotspots  Sorted list of hotspot entries from computeHotspots().
 * @param repo      Repository name (stored in logicalLocations.properties.repo).
 * @param threshold Score threshold for reporting (default 50). Files scoring
 *                  >= threshold are "warning"; >= threshold/2 are "note".
 */
export function hotspotFindings(
  hotspots: readonly HotspotEntry[],
  repo: string,
  threshold: number = 50,
): SarifResult[] {
  const halfThreshold = threshold * 0.5;
  const results: SarifResult[] = [];

  for (const h of hotspots) {
    let level: "warning" | "note";
    if (h.hotspotScore >= threshold) {
      level = "warning";
    } else if (h.hotspotScore >= halfThreshold) {
      level = "note";
    } else {
      continue;
    }

    results.push({
      ruleId: "hotspot/high-churn-complexity",
      level,
      message: {
        text: `File has high churn (${h.churn} commits) and complexity (${h.symbolCount} symbols) — hotspot score ${h.hotspotScore}/100`,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: h.filePath },
          },
          logicalLocations: [
            {
              fullyQualifiedName: h.filePath,
              kind: "module",
              properties: { repo },
            },
          ],
        },
      ],
      properties: {
        churn: h.churn,
        symbolCount: h.symbolCount,
        hotspotScore: h.hotspotScore,
      },
    });
  }

  return results;
}
