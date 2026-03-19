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

/**
 * Parent directories that strongly imply a deployable service rather than a
 * shared library. Directories under these prefixes are kept without an
 * entry-point check in Strategy 2.
 */
const SERVICE_PARENT_DIRS = new Set(["apps", "services", "src/services", "src/apps"]);

/**
 * Basenames (without extension) that typically indicate a runnable entry point.
 * Used by Strategy 2 to filter library-like directories (packages/*, modules/*).
 */
const ENTRY_POINT_BASENAMES = new Set([
  "main", "app", "server", "bootstrap", "cli", "worker", "lambda", "handler",
]);

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

    // Distinguish real services (bin/start) from libraries (main-only).
    // A package with only `main` is typically a library entry point, not
    // a deployable service. Demote to 0.5 confidence so it doesn't crowd
    // the service catalog alongside actual services.
    const hasServiceEntry = !!(pkgInfo.bin || pkgInfo.scripts["start"]);
    const confidence = hasServiceEntry ? 0.9 : 0.5;

    const deps = findServiceDependencies(dirPath, input.dependencyGraph, input.repo);

    services.push({
      name: pkgInfo.name || dirPath.split("/").pop() || dirPath,
      rootPath: dirPath,
      entryPoints,
      dependencies: deps,
      confidence,
    });
  }

  // Strategy 2: well-known directory patterns
  // Collect candidate roots first, then validate entry-point presence for
  // library-like parent directories (packages/*, modules/*).
  const candidateRoots = new Map<string, { parentDir: string; name: string }>();
  for (const filePath of input.filePaths) {
    for (const pattern of SERVICE_DIR_PATTERNS) {
      const match = pattern.exec(filePath);
      if (match) {
        const rootPath = `${match[1]}/${match[2]}`;
        if (!seen.has(rootPath) && !candidateRoots.has(rootPath)) {
          candidateRoots.set(rootPath, { parentDir: match[1]!, name: match[2]! });
        }
      }
    }
  }

  for (const [rootPath, { parentDir, name }] of candidateRoots) {
    seen.add(rootPath);

    // For library-likely parent dirs (packages, modules), require at least
    // one entry-point-like file to classify as a service.
    if (!SERVICE_PARENT_DIRS.has(parentDir)) {
      const hasEntryPoint = input.filePaths.some((fp) => {
        if (!isUnderDir(fp, rootPath)) return false;
        const rel = fp.slice(rootPath.length + 1);
        // Check files at root or src/ level (not deeply nested)
        const parts = rel.split("/");
        const fileName = parts.length <= 2 ? parts[parts.length - 1]! : null;
        if (!fileName) return false;
        const baseName = fileName.replace(/\.[^.]+$/, "");
        return ENTRY_POINT_BASENAMES.has(baseName);
      });
      if (!hasEntryPoint) continue;
    }

    const deps = findServiceDependencies(rootPath, input.dependencyGraph, input.repo);

    services.push({
      name,
      rootPath,
      entryPoints: [],
      dependencies: deps,
      confidence: 0.6,
    });
  }

  // Post-process: add package.json npm dependencies that match known service names.
  // This captures intra-repo deps (e.g., @novu/shared -> novu-libs) that don't
  // appear in the import-based dependency graph for single-service repos.
  const serviceNames = new Set(services.map((s) => s.name));
  for (let i = 0; i < services.length; i++) {
    const svc = services[i]!;
    const pkgJson = [...input.packageJsons.entries()].find(
      ([dir]) => dir === svc.rootPath || isUnderDir(svc.rootPath, dir) || isUnderDir(dir, svc.rootPath),
    );
    if (pkgJson) {
      const extraDeps: string[] = [];
      for (const depName of Object.keys(pkgJson[1].dependencies)) {
        if (serviceNames.has(depName) && depName !== svc.name && !svc.dependencies.includes(depName)) {
          extraDeps.push(depName);
        }
      }
      if (extraDeps.length > 0) {
        services[i] = { ...svc, dependencies: [...svc.dependencies, ...extraDeps] };
      }
    }
  }

  // Post-process: translate dependency file paths to service names where
  // possible. Raw paths like "packages/db/src/client.ts" become the service
  // name "db" (or "@myapp/db") when that file falls under a known service root.
  return resolveServiceDependencyNames(services);
}

function resolveServiceDependencyNames(
  services: InferredService[],
): InferredService[] {
  return services.map((svc) => ({
    ...svc,
    dependencies: svc.dependencies.map((dep) => {
      const target = services.find(
        (s) => s.rootPath !== svc.rootPath && isUnderDir(dep, s.rootPath),
      );
      return target ? target.name : dep;
    }),
  }));
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
  repo?: string,
): string[] {
  // Edge sources/targets use canonical IDs (repo:filePath) from makeFileId,
  // but rootPath is a bare directory path. Strip the repo: prefix for matching.
  const repoPrefix = repo ? `${repo}:` : undefined;
  const deps = new Set<string>();
  for (const edge of graph.edges) {
    const source = repoPrefix && edge.source.startsWith(repoPrefix)
      ? edge.source.slice(repoPrefix.length) : edge.source;
    const target = repoPrefix && edge.target.startsWith(repoPrefix)
      ? edge.target.slice(repoPrefix.length) : edge.target;
    if (
      isUnderDir(source, rootPath) &&
      !isUnderDir(target, rootPath) &&
      !target.startsWith("node_modules")
    ) {
      deps.add(target);
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
