/**
 * Vulnerability matching utilities.
 * Checks installed package versions against known advisory ranges.
 */

import { satisfies } from "semver";
import type { GraphEdge, SarifResult } from "@mma/core";

export interface Advisory {
  readonly id: string;
  readonly package: string;
  readonly vulnerableRange: string;
  readonly severity: "low" | "moderate" | "high" | "critical";
}

export interface InstalledPackage {
  readonly name: string;
  readonly version: string;
}

/**
 * Check if an installed package version is affected by an advisory.
 */
export function isVulnerable(pkg: InstalledPackage, advisory: Advisory): boolean {
  if (pkg.name !== advisory.package) return false;
  // Check if installed version falls within the vulnerable range
  return satisfies(pkg.version, advisory.vulnerableRange);
}

/**
 * Find all advisories that affect the given installed packages.
 */
export function matchAdvisories(
  installed: readonly InstalledPackage[],
  advisories: readonly Advisory[],
): Array<{ pkg: InstalledPackage; advisory: Advisory }> {
  const matches: Array<{ pkg: InstalledPackage; advisory: Advisory }> = [];
  for (const pkg of installed) {
    for (const adv of advisories) {
      if (isVulnerable(pkg, adv)) {
        matches.push({ pkg, advisory: adv });
      }
    }
  }
  return matches;
}

export interface VulnReachabilityResult {
  readonly advisory: Advisory;
  readonly pkg: InstalledPackage;
  /** Files that directly import the vulnerable package */
  readonly directImporters: readonly string[];
  /** Whether any application code reaches the vulnerable package */
  readonly reachable: boolean;
}

/**
 * Check which vulnerable packages are actually imported in the codebase.
 *
 * Scans import edges for imports from `node_modules/<package>/` to determine
 * if the vulnerable dependency is reachable from application code.
 */
export function checkVulnReachability(
  matches: readonly { pkg: InstalledPackage; advisory: Advisory }[],
  importEdges: readonly GraphEdge[],
): VulnReachabilityResult[] {
  return matches.map(({ pkg, advisory }) => {
    const pattern = `node_modules/${pkg.name}/`;
    const directImporters = importEdges
      .filter(e => e.kind === "imports" && e.target.includes(pattern))
      .map(e => e.source);

    const uniqueImporters = [...new Set(directImporters)];

    return {
      advisory,
      pkg,
      directImporters: uniqueImporters,
      reachable: uniqueImporters.length > 0,
    };
  });
}

/**
 * Convert vulnerability reachability results to SARIF diagnostics.
 */
export function vulnReachabilityToSarif(
  results: readonly VulnReachabilityResult[],
  repo: string,
): SarifResult[] {
  return results
    .filter(r => r.reachable)
    .map(r => ({
      ruleId: "vuln/reachable-dependency",
      level: r.advisory.severity === "critical" || r.advisory.severity === "high"
        ? "error" as const
        : "warning" as const,
      message: {
        text: `Reachable vulnerability: ${r.pkg.name}@${r.pkg.version} matches ${r.advisory.id} (${r.advisory.severity}). Imported by ${r.directImporters.length} file(s): ${r.directImporters.slice(0, 3).join(", ")}${r.directImporters.length > 3 ? ` and ${r.directImporters.length - 3} more` : ""}`,
      },
      locations: r.directImporters.slice(0, 1).map(f => ({
        logicalLocations: [{
          fullyQualifiedName: f,
          kind: "module",
          properties: { repo },
        }],
      })),
      properties: {
        advisoryId: r.advisory.id,
        packageName: r.pkg.name,
        packageVersion: r.pkg.version,
        severity: r.advisory.severity,
        importerCount: r.directImporters.length,
      },
    }));
}
