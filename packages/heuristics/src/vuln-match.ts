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

function mapSeverity(s: string): Advisory["severity"] {
  if (s === "info") return "low";
  if (["low", "moderate", "high", "critical"].includes(s)) return s as Advisory["severity"];
  return "low";
}

/**
 * Parse npm audit JSON output into Advisory objects.
 * Supports both npm audit v2 (npm 7+, has "vulnerabilities" key) and
 * v1 (npm 6, has "advisories" key) formats.
 */
export function parseNpmAudit(jsonString: string): Advisory[] {
  const parsed = JSON.parse(jsonString) as Record<string, unknown>;

  // npm audit v2 format (npm 7+): top-level "vulnerabilities" object
  if (parsed.vulnerabilities && typeof parsed.vulnerabilities === "object") {
    const vulns = parsed.vulnerabilities as Record<string, Record<string, unknown>>;
    return Object.entries(vulns)
      .filter(([, v]) => v !== null && typeof v === "object")
      .map(([name, v]) => {
        const via = v.via as unknown[];
        // via can be objects (actual advisories) or strings (dependency names) — find first object
        const firstAdvisory = Array.isArray(via)
          ? via.find((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
          : undefined;
        return {
          id: String(firstAdvisory?.source ?? firstAdvisory?.url ?? `npm-audit-${name}`),
          package: name,
          vulnerableRange: String(v.range ?? "*"),
          severity: mapSeverity(String(v.severity ?? "low")),
        };
      });
  }

  // npm audit v1 format: top-level "advisories" object
  if (parsed.advisories && typeof parsed.advisories === "object") {
    const advs = parsed.advisories as Record<string, Record<string, unknown>>;
    return Object.values(advs).map((adv) => ({
      id: String(adv.id ?? ""),
      package: String(adv.module_name ?? ""),
      vulnerableRange: String(adv.vulnerable_versions ?? "*"),
      severity: mapSeverity(String(adv.severity ?? "low")),
    }));
  }

  return [];
}

export interface VulnReachabilityResult {
  readonly advisory: Advisory;
  readonly pkg: InstalledPackage;
  /** Files that directly import the vulnerable package */
  readonly directImporters: readonly string[];
  /** Whether any application code reaches the vulnerable package */
  readonly reachable: boolean;
  /** Files that transitively import a direct importer of the vulnerable package */
  readonly transitiveImporters?: readonly string[];
  /** Total files that can reach the vulnerable package (direct + transitive) */
  readonly totalReach?: number;
  /** Maximum depth of the transitive import chain */
  readonly maxDepth?: number;
}

/**
 * Check which vulnerable packages are actually imported in the codebase.
 *
 * Scans import edges for bare specifier matches (e.g., "@nestjs/common" or
 * "lodash/chunk") to determine if the vulnerable dependency is reachable
 * from application code.
 */
export function checkVulnReachability(
  matches: readonly { pkg: InstalledPackage; advisory: Advisory }[],
  importEdges: readonly GraphEdge[],
): VulnReachabilityResult[] {
  return matches.map(({ pkg, advisory }) => {
    // Import edges store external packages as bare specifiers (e.g., "@nestjs/common",
    // "lodash/chunk"), not resolved node_modules paths. Match against the package name
    // as a prefix (exact match or subpath import).
    const directImporters = importEdges
      .filter(e => e.kind === "imports" && (
        e.target === pkg.name ||
        e.target.startsWith(pkg.name + "/")
      ))
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
 * Check vulnerability reachability with transitive analysis.
 *
 * First finds direct importers (like checkVulnReachability), then performs
 * reverse BFS from direct importers through import and call edges to find
 * all transitive importers.
 */
export function checkTransitiveVulnReachability(
  matches: readonly { pkg: InstalledPackage; advisory: Advisory }[],
  allEdges: readonly GraphEdge[],
  options?: { maxDepth?: number },
): VulnReachabilityResult[] {
  const maxDepth = options?.maxDepth ?? 10;

  // Build reverse adjacency: for each target, who imports/calls it?
  const reverseAdj = new Map<string, string[]>();
  for (const edge of allEdges) {
    if (edge.kind !== "imports" && edge.kind !== "calls") continue;
    let sources = reverseAdj.get(edge.target);
    if (!sources) {
      sources = [];
      reverseAdj.set(edge.target, sources);
    }
    sources.push(edge.source);
  }

  // Get direct reachability first
  const directResults = checkVulnReachability(matches, allEdges);

  return directResults.map((result) => {
    if (!result.reachable || result.directImporters.length === 0) {
      return result;
    }

    // Reverse BFS from direct importers to find transitive importers
    const visited = new Set<string>(result.directImporters);
    const queue: Array<{ node: string; depth: number }> = result.directImporters.map(
      (f) => ({ node: f, depth: 0 }),
    );
    let maxDepthSeen = 0;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth > maxDepthSeen) maxDepthSeen = current.depth;
      if (current.depth >= maxDepth) continue;

      const dependents = reverseAdj.get(current.node);
      if (dependents) {
        for (const dep of dependents) {
          if (!visited.has(dep)) {
            visited.add(dep);
            queue.push({ node: dep, depth: current.depth + 1 });
          }
        }
      }
    }

    // Transitive importers = all visited minus direct importers
    const directSet = new Set(result.directImporters);
    const transitiveImporters = [...visited].filter((f) => !directSet.has(f));

    return {
      ...result,
      transitiveImporters,
      totalReach: result.directImporters.length + transitiveImporters.length,
      maxDepth: maxDepthSeen,
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

/**
 * Convert vulnerability reachability results to SARIF diagnostics with codeFlows.
 *
 * Like vulnReachabilityToSarif but adds codeFlows showing the import chain
 * when transitive importers are present.
 */
export function vulnReachabilityToSarifWithCodeFlows(
  results: readonly VulnReachabilityResult[],
  repo: string,
): SarifResult[] {
  return results
    .filter((r) => r.reachable)
    .map((r) => {
      const totalImporters = (r.totalReach ?? r.directImporters.length);
      const base: SarifResult = {
        ruleId: "vuln/reachable-dependency",
        level:
          r.advisory.severity === "critical" || r.advisory.severity === "high"
            ? ("error" as const)
            : ("warning" as const),
        message: {
          text: `Reachable vulnerability: ${r.pkg.name}@${r.pkg.version} matches ${r.advisory.id} (${r.advisory.severity}). Imported by ${totalImporters} file(s): ${r.directImporters.slice(0, 3).join(", ")}${r.directImporters.length > 3 ? ` and ${r.directImporters.length - 3} more` : ""}${r.transitiveImporters && r.transitiveImporters.length > 0 ? ` (${r.transitiveImporters.length} transitive)` : ""}`,
        },
        locations: r.directImporters.slice(0, 1).map((f) => ({
          logicalLocations: [
            {
              fullyQualifiedName: f,
              kind: "module",
              properties: { repo },
            },
          ],
        })),
        properties: {
          advisoryId: r.advisory.id,
          packageName: r.pkg.name,
          packageVersion: r.pkg.version,
          severity: r.advisory.severity,
          importerCount: totalImporters,
          directImporterCount: r.directImporters.length,
          transitiveImporterCount: r.transitiveImporters?.length ?? 0,
        },
      };

      // Add codeFlows when transitive importers exist
      if (r.transitiveImporters && r.transitiveImporters.length > 0) {
        const threadFlowLocations = [
          // Show first transitive importer
          ...r.transitiveImporters.slice(0, 3).map((ti) => ({
            location: {
              logicalLocations: [{ fullyQualifiedName: ti, kind: "module" as const }],
            },
            nestingLevel: 0,
          })),
          // Direct importer
          ...r.directImporters.slice(0, 1).map((di) => ({
            location: {
              logicalLocations: [{ fullyQualifiedName: di, kind: "module" as const }],
            },
            nestingLevel: 1,
          })),
          // Vulnerable package
          {
            location: {
              logicalLocations: [{ fullyQualifiedName: r.pkg.name, kind: "package" as const }],
            },
            nestingLevel: 2,
          },
        ];

        return {
          ...base,
          codeFlows: [{ threadFlows: [{ locations: threadFlowLocations }] }],
        };
      }

      return base;
    });
}
