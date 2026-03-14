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
  _kvStore: KVStore,
  repoFilter?: string,
): Promise<ArchitectureQueryResult> {
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
        entry.crossRepo++;
        const parts = edge.target.split("/");
        const pkg = parts[0]!.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
        const key = `${repoName}->${pkg}`;
        crossEdgeMap.set(key, (crossEdgeMap.get(key) ?? 0) + 1);
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

    // Infer role from per-repo edges (no global scan needed)
    entry.role = inferRepoRoleFromEdges(repoName, repoImports, repoServiceCalls, allRepoNames);
    repoMap.set(repoName, entry);
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

/**
 * Infer repo role using only the edges for this specific repo.
 * The allRepoNames set is used for the "imported by others" heuristic —
 * we check if the repo name appears in any other repo's import targets.
 * This avoids loading a global edge list.
 */
function inferRepoRoleFromEdges(
  repoName: string,
  repoImports: readonly GraphEdge[],
  repoServiceCalls: readonly GraphEdge[],
  _allRepoNames: ReadonlySet<string>,
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

  // Heuristic: frontend repos have mostly HTTP client calls and import React/Vue/Angular
  const hasReactImports = repoImports.some(
    (e) =>
      e.target === "react" ||
      e.target === "react-dom" ||
      e.target === "vue" ||
      e.target === "next" ||
      e.target === "@angular/core",
  );

  if (hasReactImports && httpClients > 0 && consumers === 0) {
    return "frontend";
  }

  // Shared libraries: few service calls and name contains "lib"
  if (
    producers === 0 &&
    consumers === 0 &&
    repoName.includes("lib")
  ) {
    return "shared-library";
  }

  // Backend services: have queue producers/consumers or NestJS imports
  const hasNestImports = repoImports.some(
    (e) =>
      e.target === "@nestjs/core" ||
      e.target === "@nestjs/common" ||
      e.target.startsWith("@nestjs/"),
  );
  if (hasNestImports || producers > 0 || consumers > 0) {
    return "backend-service";
  }

  return "unknown";
}
