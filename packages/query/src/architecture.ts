/**
 * Cross-repo architecture query handler.
 *
 * Returns a composite view of the indexed codebase:
 * - Repo roles (frontend, backend-service, shared-library)
 * - Cross-repo dependency counts
 * - Service communication topology (queue/HTTP edges)
 */

import type { GraphEdge } from "@mma/core";
import type { GraphStore, KVStore } from "@mma/storage";

export interface ArchitectureQueryResult {
  readonly repos: readonly RepoSummary[];
  readonly crossRepoEdges: readonly CrossRepoEdge[];
  readonly serviceTopology: readonly ServiceLink[];
  readonly description: string;
}

export interface RepoSummary {
  readonly name: string;
  readonly role: "frontend" | "backend-service" | "shared-library" | "unknown";
  readonly importCount: number;
  readonly callCount: number;
  readonly crossRepoImports: number;
  readonly serviceCallCount: number;
}

export interface CrossRepoEdge {
  readonly sourceRepo: string;
  readonly targetPackage: string;
  readonly count: number;
}

export interface ServiceLink {
  readonly sourceRepo: string;
  readonly sourceFile: string;
  readonly target: string;
  readonly protocol: string;
  readonly role: string;
  readonly detail: string;
}

export async function executeArchitectureQuery(
  graphStore: GraphStore,
  kvStore: KVStore,
  repoFilter?: string,
): Promise<ArchitectureQueryResult> {
  // Load known indexed packages for accurate cross-repo counting.
  // Only imports targeting packages in indexed repos should count as cross-repo;
  // third-party packages like @nestjs/common or @tanstack/react-query are excluded.
  const packageRootsJson = await kvStore.get("_packageRoots");
  const indexedPackages = new Set<string>();
  if (packageRootsJson) {
    try {
      const entries = JSON.parse(packageRootsJson) as [string, string][];
      for (const [name] of entries) indexedPackages.add(name);
    } catch { /* ignore malformed cache */ }
  }

  // Get aggregate counts per repo without loading all edges into memory
  const importCounts = await graphStore.getEdgeCountsByKindAndRepo("imports");
  const callCounts = await graphStore.getEdgeCountsByKindAndRepo("calls");
  const serviceCallCounts = await graphStore.getEdgeCountsByKindAndRepo("service-call");

  // Discover all repos from the count maps
  const allRepoNames = new Set<string>([
    ...importCounts.keys(),
    ...callCounts.keys(),
    ...serviceCallCounts.keys(),
  ]);

  // Determine which repos we need to load edges for (cross-repo + role inference + topology)
  const reposToProcess = repoFilter
    ? [...allRepoNames].filter((r) => r === repoFilter)
    : [...allRepoNames];

  // Build repo summaries and collect cross-repo edges + service topology per repo
  const repoMap = new Map<string, {
    imports: number; calls: number; crossRepo: number;
    serviceCalls: number; role: RepoSummary["role"];
  }>();
  const crossEdgeMap = new Map<string, number>();
  const serviceTopology: ServiceLink[] = [];
  // Cache edges per repo for role inference (avoids double-loading)
  const repoEdgeCache = new Map<string, { imports: readonly GraphEdge[]; serviceCalls: readonly GraphEdge[] }>();

  for (const repoName of reposToProcess) {
    const entry = {
      imports: importCounts.get(repoName) ?? 0,
      calls: callCounts.get(repoName) ?? 0,
      crossRepo: 0,
      serviceCalls: serviceCallCounts.get(repoName) ?? 0,
      role: "unknown" as RepoSummary["role"],
    };

    // Load imports for this repo to compute cross-repo edges and role
    const repoImports = await graphStore.getEdgesByKind("imports", repoName);
    for (const edge of repoImports) {
      if (edge.target.startsWith("@") && !edge.target.startsWith("@/")) {
        const parts = edge.target.split("/");
        const pkg = parts[0]!.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
        // Only count as cross-repo if the target package is in an indexed repo.
        // When indexedPackages is empty (no cache yet), fall back to counting all.
        if (indexedPackages.size === 0 || indexedPackages.has(pkg)) {
          entry.crossRepo++;
          const key = `${repoName}->${pkg}`;
          crossEdgeMap.set(key, (crossEdgeMap.get(key) ?? 0) + 1);
        }
      }
    }

    // Load service-calls for this repo for topology + role inference
    const repoServiceCalls = await graphStore.getEdgesByKind("service-call", repoName);
    for (const edge of repoServiceCalls) {
      serviceTopology.push({
        sourceRepo: repoName,
        sourceFile: edge.source,
        target: edge.target,
        protocol: (edge.metadata?.protocol as string) ?? "unknown",
        role: (edge.metadata?.role as string) ?? "unknown",
        detail: (edge.metadata?.detail as string) ?? "",
      });
    }

    repoEdgeCache.set(repoName, { imports: repoImports, serviceCalls: repoServiceCalls });
    repoMap.set(repoName, entry);
  }

  // Build fan-in map: how many distinct repos import each target package
  const packageFanIn = new Map<string, number>();
  for (const key of crossEdgeMap.keys()) {
    const [, targetPkg] = key.split("->");
    if (targetPkg) {
      packageFanIn.set(targetPkg, (packageFanIn.get(targetPkg) ?? 0) + 1);
    }
  }

  // Infer roles now that fan-in data is available
  for (const repoName of reposToProcess) {
    const cached = repoEdgeCache.get(repoName)!;
    const entry = repoMap.get(repoName)!;
    entry.role = inferRepoRoleFromEdges(repoName, cached.imports, cached.serviceCalls, allRepoNames, packageFanIn, indexedPackages);
  }

  // If no repoFilter, also add repos we didn't process (they have zero edges in filter scope)
  if (!repoFilter) {
    for (const name of allRepoNames) {
      if (!repoMap.has(name)) {
        repoMap.set(name, {
          imports: importCounts.get(name) ?? 0,
          calls: callCounts.get(name) ?? 0,
          crossRepo: 0,
          serviceCalls: serviceCallCounts.get(name) ?? 0,
          role: "unknown",
        });
      }
    }
  }

  const crossRepoEdges: CrossRepoEdge[] = [];
  for (const [key, count] of crossEdgeMap) {
    const [sourceRepo, targetPackage] = key.split("->");
    crossRepoEdges.push({
      sourceRepo: sourceRepo!,
      targetPackage: targetPackage!,
      count,
    });
  }
  crossRepoEdges.sort((a, b) => b.count - a.count);

  // Build repos array
  const repos: RepoSummary[] = [];
  for (const [name, entry] of repoMap) {
    repos.push({
      name,
      role: entry.role,
      importCount: entry.imports,
      callCount: entry.calls,
      crossRepoImports: entry.crossRepo,
      serviceCallCount: entry.serviceCalls,
    });
  }
  repos.sort((a, b) => a.name.localeCompare(b.name));

  // Build description
  const totalRepos = repos.length;
  const totalCrossRepo = crossRepoEdges.reduce((sum, e) => sum + e.count, 0);
  const totalServiceCalls = serviceTopology.length;
  const description =
    `Architecture overview: ${totalRepos} repos, ` +
    `${totalCrossRepo} cross-repo import edges, ` +
    `${totalServiceCalls} service communication links`;

  return { repos, crossRepoEdges, serviceTopology, description };
}

/** Package names that indicate a shared-library repo */
const LIBRARY_NAME_PATTERNS = ["lib", "shared", "common", "utils", "types", "sdk", "helpers"];

/** HTTP server frameworks whose presence signals a backend service */
const SERVER_FRAMEWORK_IMPORTS = new Set([
  "express", "fastify", "koa", "hapi", "@hapi/hapi",
  "@hapi/server", "restify", "polka", "micro",
]);

/** Frontend framework imports */
const FRONTEND_FRAMEWORK_IMPORTS = new Set([
  "react", "react-dom", "vue", "next", "@angular/core",
  "svelte", "solid-js", "@remix-run/react",
]);

/**
 * Infer repo role using the edges for this specific repo plus cross-repo fan-in data.
 *
 * @param packageFanIn - map of package name → number of distinct repos that import it
 * @param indexedPackages - set of package names from indexed repos (used to match repo to package)
 */
function inferRepoRoleFromEdges(
  repoName: string,
  repoImports: readonly GraphEdge[],
  repoServiceCalls: readonly GraphEdge[],
  _allRepoNames: ReadonlySet<string>,
  packageFanIn: ReadonlyMap<string, number>,
  indexedPackages: ReadonlySet<string>,
): RepoSummary["role"] {
  // Count producer vs consumer edges
  const producers = repoServiceCalls.filter(
    (e) => e.metadata?.role === "producer",
  ).length;
  const consumers = repoServiceCalls.filter(
    (e) => e.metadata?.role === "consumer",
  ).length;
  const httpClients = repoServiceCalls.filter(
    (e) => e.metadata?.protocol === "http",
  ).length;

  // Heuristic: frontend repos import React/Vue/Angular and make HTTP calls
  const hasFrontendImports = repoImports.some(
    (e) => FRONTEND_FRAMEWORK_IMPORTS.has(e.target),
  );

  if (hasFrontendImports && httpClients > 0 && consumers === 0) {
    return "frontend";
  }

  // Frontend can also be detected without HTTP calls if the repo is purely UI
  // (e.g., component library with React but no service calls at all)
  if (hasFrontendImports && repoServiceCalls.length === 0) {
    // If the repo name also suggests a library, prefer shared-library
    const nameSuggestsLibrary = LIBRARY_NAME_PATTERNS.some(
      (p) => repoName.toLowerCase().includes(p),
    );
    if (!nameSuggestsLibrary) {
      return "frontend";
    }
  }

  // Cross-repo fan-in: if 3+ other repos import a package matching this repo → shared-library
  // Match the repo name against indexed package names
  const matchingPackage = [...indexedPackages].find(
    (pkg) => pkg.includes(repoName) || repoName.includes(pkg.replace(/^@[^/]+\//, "")),
  );
  if (matchingPackage) {
    const fanIn = packageFanIn.get(matchingPackage) ?? 0;
    if (fanIn >= 3 && producers === 0 && consumers === 0) {
      return "shared-library";
    }
  }

  // Shared libraries: no service calls and name suggests a library
  if (
    producers === 0 &&
    consumers === 0 &&
    LIBRARY_NAME_PATTERNS.some((p) => repoName.toLowerCase().includes(p))
  ) {
    return "shared-library";
  }

  // Backend services: HTTP server frameworks
  const hasServerFramework = repoImports.some(
    (e) => SERVER_FRAMEWORK_IMPORTS.has(e.target),
  );
  if (hasServerFramework) {
    return "backend-service";
  }

  // Backend services: NestJS imports
  const hasNestImports = repoImports.some(
    (e) => e.target.startsWith("@nestjs/"),
  );
  if (hasNestImports || producers > 0 || consumers > 0) {
    return "backend-service";
  }

  // Node.js builtin imports (node:http, node:fs, etc.) combined with no frontend
  // signals suggest a backend or CLI tool
  const nodeBuiltinCount = repoImports.filter(
    (e) => e.target.startsWith("node:"),
  ).length;
  if (nodeBuiltinCount >= 3 && !hasFrontendImports) {
    return "backend-service";
  }

  return "unknown";
}
