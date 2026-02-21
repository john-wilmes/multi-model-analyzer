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
  // Get all edges, grouped by repo
  const allImports = await graphStore.getEdgesByKind("imports");
  const allCalls = await graphStore.getEdgesByKind("calls");
  const allServiceCalls = await graphStore.getEdgesByKind("service-call");

  // Build repo summaries
  const repoMap = new Map<
    string,
    {
      imports: number;
      calls: number;
      crossRepo: number;
      serviceCalls: number;
      role: RepoSummary["role"];
    }
  >();

  function ensureRepo(name: string) {
    if (!repoMap.has(name)) {
      repoMap.set(name, {
        imports: 0,
        calls: 0,
        crossRepo: 0,
        serviceCalls: 0,
        role: "unknown",
      });
    }
    return repoMap.get(name)!;
  }

  for (const edge of allImports) {
    const repo = (edge.metadata?.repo as string) ?? "unknown";
    const entry = ensureRepo(repo);
    entry.imports++;
    if (edge.target.startsWith("@") && !edge.target.startsWith("@/")) {
      entry.crossRepo++;
    }
  }

  for (const edge of allCalls) {
    const repo = (edge.metadata?.repo as string) ?? "unknown";
    ensureRepo(repo).calls++;
  }

  for (const edge of allServiceCalls) {
    const repo = (edge.metadata?.repo as string) ?? "unknown";
    ensureRepo(repo).serviceCalls++;
  }

  // Infer repo roles from heuristics
  for (const [name, entry] of repoMap) {
    entry.role = inferRepoRole(name, allImports, allServiceCalls);
  }

  // Build cross-repo edges (which repo imports which packages)
  const crossEdgeMap = new Map<string, number>();
  for (const edge of allImports) {
    const repo = (edge.metadata?.repo as string) ?? "unknown";
    if (repoFilter && repo !== repoFilter) continue;
    if (edge.target.startsWith("@") && !edge.target.startsWith("@/")) {
      // Normalize to base package (e.g., @novu/shared/utils -> @novu/shared)
      const parts = edge.target.split("/");
      const pkg = parts[0]!.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
      const key = `${repo}->${pkg}`;
      crossEdgeMap.set(key, (crossEdgeMap.get(key) ?? 0) + 1);
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

  // Build service topology links
  const serviceTopology: ServiceLink[] = [];
  for (const edge of allServiceCalls) {
    const repo = (edge.metadata?.repo as string) ?? "unknown";
    if (repoFilter && repo !== repoFilter) continue;
    serviceTopology.push({
      sourceRepo: repo,
      sourceFile: edge.source,
      target: edge.target,
      protocol: (edge.metadata?.protocol as string) ?? "unknown",
      role: (edge.metadata?.role as string) ?? "unknown",
      detail: (edge.metadata?.detail as string) ?? "",
    });
  }

  // Build repos array
  const repos: RepoSummary[] = [];
  for (const [name, entry] of repoMap) {
    if (repoFilter && name !== repoFilter) continue;
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

function inferRepoRole(
  repoName: string,
  imports: readonly GraphEdge[],
  serviceCalls: readonly GraphEdge[],
): RepoSummary["role"] {
  const repoImports = imports.filter(
    (e) => (e.metadata?.repo as string) === repoName,
  );
  const repoServiceCalls = serviceCalls.filter(
    (e) => (e.metadata?.repo as string) === repoName,
  );

  // Check if other repos import from packages in this repo
  const isImportedByOthers = imports.some((e) => {
    const sourceRepo = e.metadata?.repo as string;
    return sourceRepo !== repoName && e.target.includes(repoName);
  });

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

  // Shared libraries: imported by many other repos, few service calls
  if (
    isImportedByOthers &&
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
