/**
 * Service boundary inference from folder structure, package.json, and entry points.
 *
 * Heuristic: a "service" is a directory that has its own package.json with a
 * main/bin entry point, or follows common monorepo patterns (apps/*, services/*).
 */

import type { InferredService, InferredArchitecture, DependencyGraph, HeuristicResult } from "@mma/core";
import { runHeuristic } from "@mma/core";

export interface ServiceInferenceInput {
  readonly repo: string;
  readonly filePaths: readonly string[];
  readonly packageJsons: ReadonlyMap<string, PackageJsonInfo>;
  readonly dependencyGraph: DependencyGraph;
}

export interface PackageJsonInfo {
  readonly name: string;
  readonly main?: string;
  readonly bin?: Record<string, string>;
  readonly dependencies: Record<string, string>;
  readonly scripts: Record<string, string>;
}

const SERVICE_DIR_PATTERNS = [
  /^(apps|services|packages|modules)\/([^/]+)\//,
  /^(src\/services|src\/apps|src\/modules)\/([^/]+)\//,
];

export function inferServices(input: ServiceInferenceInput): InferredService[] {
  const services: InferredService[] = [];
  const seen = new Set<string>();

  // Strategy 1: directories with their own package.json
  for (const [dirPath, pkgInfo] of input.packageJsons) {
    if (seen.has(dirPath)) continue;
    seen.add(dirPath);

    const entryPoints: string[] = [];
    if (pkgInfo.main) entryPoints.push(pkgInfo.main);
    if (pkgInfo.bin) entryPoints.push(...Object.values(pkgInfo.bin));
    if (pkgInfo.scripts["start"]) entryPoints.push("(start script)");

    // Skip library-only packages that have no executable entry point.
    // A package.json without main/bin/start is almost certainly a shared
    // library, not a deployable service. Including it at 0.9 confidence
    // would flood the service catalog with non-service entries.
    if (entryPoints.length === 0) continue;

    const deps = findServiceDependencies(dirPath, input.dependencyGraph);

    services.push({
      name: pkgInfo.name || dirPath.split("/").pop() || dirPath,
      rootPath: dirPath,
      entryPoints,
      dependencies: deps,
      confidence: 0.9,
    });
  }

  // Strategy 2: well-known directory patterns
  for (const filePath of input.filePaths) {
    for (const pattern of SERVICE_DIR_PATTERNS) {
      const match = pattern.exec(filePath);
      if (match) {
        const serviceName = match[2]!;
        const rootPath = `${match[1]}/${serviceName}`;
        if (seen.has(rootPath)) continue;
        seen.add(rootPath);

        const deps = findServiceDependencies(rootPath, input.dependencyGraph);

        services.push({
          name: serviceName,
          rootPath,
          entryPoints: [],
          dependencies: deps,
          confidence: 0.6,
        });
      }
    }
  }

  return services;
}

/**
 * Returns true when `filePath` is rooted at `dirPath`.
 *
 * Requires the match to occur at a path-separator boundary so that a service
 * rooted at "apps/api" does not accidentally absorb files belonging to the
 * sibling "apps/api-gateway" service.
 */
function isUnderDir(filePath: string, dirPath: string): boolean {
  return (
    filePath === dirPath ||
    filePath.startsWith(dirPath + "/")
  );
}

function findServiceDependencies(
  rootPath: string,
  graph: DependencyGraph,
): string[] {
  const deps = new Set<string>();
  for (const edge of graph.edges) {
    if (
      isUnderDir(edge.source, rootPath) &&
      !isUnderDir(edge.target, rootPath) &&
      !edge.target.startsWith("node_modules")
    ) {
      deps.add(edge.target);
    }
  }
  return [...deps];
}

export function inferServicesWithMeta(input: ServiceInferenceInput): HeuristicResult<InferredService[]> {
  return runHeuristic(input.repo, "inferServices", () => inferServices(input), (d) => d);
}

export function buildArchitecture(
  repo: string,
  services: readonly InferredService[],
  patterns: readonly import("@mma/core").DetectedPattern[],
): InferredArchitecture {
  return { services, patterns, repo };
}
