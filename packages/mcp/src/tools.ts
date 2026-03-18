import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphStore, SearchStore, KVStore } from "@mma/storage";
import { getSarifResultsPaginated } from "@mma/storage";
import type { DetectedPattern, FaultTree, SarifLog } from "@mma/core";
import { findDependencyPaths, computeCrossRepoImpact } from "@mma/correlation";
import type { CrossRepoGraph } from "@mma/correlation";
import {
  routeQuery,
  executeSearchQuery,
  executeCallersQuery,
  executeCalleesQuery,
  executeDependencyQuery,
  executeArchitectureQuery,
  computeBlastRadius,
  computePageRank,
  getFlagInventory,
  computeFlagImpact,
} from "@mma/query";
import type { ModuleMetrics, RepoMetricsSummary } from "@mma/core";
import { z } from "zod";

export interface Stores {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
}

type ContentItem =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string; description?: string };
type ToolResult = { content: ContentItem[] };

function jsonResult(data: unknown, resourceLinks?: Array<{ uri: string; name: string; description?: string }>): ToolResult {
  const content: ContentItem[] = [{ type: "text" as const, text: JSON.stringify(data, null, 2) }];
  if (resourceLinks) {
    for (const link of resourceLinks) {
      content.push({ type: "resource_link" as const, ...link });
    }
  }
  return { content };
}

function paginated<T>(items: readonly T[], offset: number, limit: number): { total: number; returned: number; offset: number; hasMore: boolean; results: T[] } {
  const page = items.slice(offset, offset + limit);
  return { total: items.length, returned: page.length, offset, hasMore: offset + limit < items.length, results: page };
}

export function registerTools(server: McpServer, stores: Stores): void {
  const { graphStore, searchStore, kvStore } = stores;

  // 1. Natural language query (catch-all)
  server.registerTool("query", {
    description: "Route a natural language question to the appropriate analysis backend. Supports structural queries (callers, callees, dependencies, circular deps), search, diagnostics, architecture, patterns, documentation, and fault trees.",
    inputSchema: {
      query: z.string().describe("Natural language question about the codebase"),
      repo: z.string().optional().describe("Filter to a specific repository name"),
    },
  }, async ({ query, repo: repoParam }) => {
    const decision = routeQuery(query);
    const repo = repoParam ?? decision.repo;
    const result = await dispatchRoute(decision.route, { ...decision, repo }, stores);
    return jsonResult({
      route: decision.route,
      confidence: decision.confidence,
      repo: repo ?? null,
      entities: decision.extractedEntities,
      result,
    });
  });

  // 2. Full-text symbol search
  server.registerTool("search", {
    description: "Search for symbols, files, and code across indexed repositories using BM25 full-text search.",
    inputSchema: {
      query: z.string().describe("Search terms"),
      repo: z.string().optional().describe("Filter to a specific repository name"),
      limit: z.number().optional().describe("Max results to return (default 10)"),
      offset: z.number().optional().describe("Number of results to skip for pagination (default 0)"),
    },
  }, async ({ query, repo, limit, offset }) => {
    // Fetch enough results to paginate from
    const cap = (limit ?? 10) + (offset ?? 0);
    const result = await executeSearchQuery(query, searchStore, cap);
    const hits = repo
      ? result.results.filter((h) => h.metadata?.["repo"] === repo)
      : result.results;
    const page = paginated(hits, offset ?? 0, limit ?? 10);
    return jsonResult(page);
  });

  // 3. Who calls a symbol
  server.registerTool("get_callers", {
    description: "Find all callers of a symbol. Accepts fully qualified names (file.ts#ClassName) or short names (resolved via BM25 fallback).",
    inputSchema: {
      symbol: z.string().describe("Symbol name or FQN to look up callers for"),
      repo: z.string().optional().describe("Filter to a specific repository name"),
    },
  }, async ({ symbol, repo }) => {
    const result = await executeCallersQuery(symbol, graphStore, repo, searchStore);
    return jsonResult(result);
  });

  // 4. What does a symbol call
  server.registerTool("get_callees", {
    description: "Find all symbols called by a given symbol. Accepts fully qualified names or short names.",
    inputSchema: {
      symbol: z.string().describe("Symbol name or FQN to look up callees for"),
      repo: z.string().optional().describe("Filter to a specific repository name"),
    },
  }, async ({ symbol, repo }) => {
    const result = await executeCalleesQuery(symbol, graphStore, repo, searchStore);
    return jsonResult(result);
  });

  // 5. Dependency graph traversal
  server.registerTool("get_dependencies", {
    description: "Traverse the dependency graph from a symbol or module. Returns edges within maxDepth hops.",
    inputSchema: {
      symbol: z.string().describe("Symbol name, FQN, or file path to start traversal from"),
      repo: z.string().optional().describe("Filter to a specific repository name"),
      maxDepth: z.number().optional().describe("Max traversal depth (default 3)"),
    },
  }, async ({ symbol, repo, maxDepth }) => {
    const opts = repo
      ? { maxDepth: maxDepth ?? 3, repo }
      : maxDepth ?? 3;
    const result = await executeDependencyQuery(symbol, graphStore, opts, searchStore);
    return jsonResult(result);
  });

  // 6. Cross-repo architecture overview
  server.registerTool("get_architecture", {
    description: "Get a cross-repo architecture overview: repo roles, cross-repo dependencies, and service communication topology (queues, HTTP, WebSocket).",
    inputSchema: {
      repo: z.string().optional().describe("Filter to a specific repository name"),
    },
  }, async ({ repo }) => {
    const result = await executeArchitectureQuery(graphStore, kvStore, repo);
    return jsonResult(result);
  });

  // 7. SARIF diagnostics
  server.registerTool("get_diagnostics", {
    description: "Retrieve SARIF diagnostic findings from the analysis index. Filter by repository, severity level, or keyword search.",
    inputSchema: {
      query: z.string().optional().describe("Keywords to filter diagnostics by (matches ruleId and message text)"),
      repo: z.string().optional().describe("Filter to a specific repository name"),
      level: z.enum(["error", "warning", "note"]).optional().describe("Filter by severity level"),
      limit: z.number().optional().describe("Max results to return (default 50)"),
      offset: z.number().optional().describe("Number of results to skip for pagination (default 0)"),
    },
  }, async ({ query, repo, level, limit, offset }) => {
    // Use per-repo SARIF keys when available (avoids parsing monolithic blob)
    const { results: allResults, total } = await getSarifResultsPaginated(kvStore, {
      repo,
      level,
      limit: 10000, // Get all for keyword filtering, then paginate
      offset: 0,
    });

    if (total === 0 && !repo && !level) {
      // Check if any data exists at all
      const hasData = await kvStore.has("sarif:latest") || await kvStore.has("sarif:latest:index");
      if (!hasData) {
        return jsonResult({ error: "No analysis results available. Run 'mma index' first.", results: [] });
      }
    }

    const keywords = query
      ? query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
      : [];

    let matching = allResults;
    if (keywords.length > 0) {
      matching = allResults.filter((res) => {
        const text = `${res.ruleId} ${res.message.text}`.toLowerCase();
        const hits = keywords.filter((kw) => text.includes(kw)).length;
        return hits >= Math.max(1, Math.ceil(keywords.length / 2));
      });
    }

    const page = paginated(matching, offset ?? 0, limit ?? 50);
    const links = repo
      ? [{ uri: `mma://repo/${repo}/findings`, name: `${repo} findings`, description: "Full findings for this repository" }]
      : undefined;
    return jsonResult(page, links);
  });
  // 8. Module instability metrics
  server.registerTool("get_metrics", {
    description: "Get module instability metrics (coupling, abstractness, distance from main sequence) for indexed repositories.",
    inputSchema: {
      repo: z.string().optional().describe("Filter to a specific repository name"),
      module: z.string().optional().describe("Filter to a specific module (file path)"),
      limit: z.number().optional().describe("Max repos or modules to return (default all)"),
      offset: z.number().optional().describe("Number of results to skip for pagination (default 0)"),
    },
  }, async ({ repo, module, limit, offset }) => {
    const data = await getMetrics(kvStore, module, repo);
    if (module && Array.isArray((data as Record<string, unknown>).modules)) {
      const modules = (data as { modules: unknown[] }).modules;
      const page = paginated(modules, offset ?? 0, limit ?? modules.length);
      return jsonResult({ moduleFilter: module, ...page });
    }
    if (Array.isArray((data as Record<string, unknown>).repos)) {
      const repos = (data as { repos: unknown[] }).repos;
      if (limit || offset) {
        const page = paginated(repos, offset ?? 0, limit ?? repos.length);
        return jsonResult({ ...page });
      }
    }
    const links = repo
      ? [{ uri: `mma://repo/${repo}/metrics`, name: `${repo} metrics`, description: "Full metrics for this repository" }]
      : undefined;
    return jsonResult(data, links);
  });

  // 10. Cross-repo dependency graph
  server.registerTool("get_cross_repo_graph", {
    description: "Get the cross-repo dependency graph showing which repos depend on which via resolved import/depends-on edges",
    inputSchema: {
      repo: z.string().optional().describe("Filter to edges involving this repo"),
      includePaths: z.boolean().optional().describe("Include dependency paths between repos"),
    },
  }, async ({ repo, includePaths }) => {
    const raw = await kvStore.get("correlation:graph");
    if (!raw) {
      return jsonResult({ error: "No correlation data. Run 'mma index' with 2+ repos first." });
    }
    const parsed = JSON.parse(raw) as {
      edges: CrossRepoGraph["edges"];
      repoPairs: string[];
      downstreamMap: [string, string[]][];
      upstreamMap: [string, string[]][];
    };
    const graph = deserializeGraph(parsed);

    const filteredEdges = repo
      ? graph.edges.filter((e) => e.sourceRepo === repo || e.targetRepo === repo)
      : graph.edges;

    const result: Record<string, unknown> = {
      repoCount: new Set([...graph.repoPairs].flatMap((p) => p.split("->"))).size,
      edgeCount: filteredEdges.length,
      repoPairs: [...graph.repoPairs],
      edges: filteredEdges,
      downstreamMap: [...graph.downstreamMap.entries()].map(([k, v]) => [k, [...v]]),
      upstreamMap: [...graph.upstreamMap.entries()].map(([k, v]) => [k, [...v]]),
    };

    if (includePaths && graph.edges.length > 0) {
      const repoList = [...new Set(graph.edges.flatMap((e) => [e.sourceRepo, e.targetRepo]))];
      if (repoList.length > 20) {
        result["pathsSkipped"] = true;
        result["pathsSkippedReason"] =
          `Path computation skipped: ${repoList.length} repos exceeds the 20-repo limit. ` +
          "Filter by repo or reduce scope to enable path results.";
      } else {
        const paths: Record<string, unknown[]> = {};
        for (const src of repoList) {
          for (const tgt of repoList) {
            if (src !== tgt) {
              const found = findDependencyPaths(src, tgt, graph);
              if (found.length > 0) {
                paths[`${src}->${tgt}`] = found;
              }
            }
          }
        }
        result["paths"] = paths;
      }
    }

    return jsonResult(result);
  });

  // 11. Cross-repo service correlation
  server.registerTool("get_service_correlation", {
    description: "Get cross-repo service correlation: linchpin services with high cross-repo coupling and orphaned services",
    inputSchema: {
      endpoint: z.string().optional().describe("Filter by endpoint substring (case-insensitive)"),
      kind: z.enum(["linchpins", "orphaned", "all"]).optional().describe("Which subset to return (default: all)"),
      limit: z.number().optional().describe("Max results to return (default 50)"),
      offset: z.number().optional().describe("Number of results to skip for pagination (default 0)"),
    },
  }, async ({ endpoint, kind, limit, offset }) => {
    const raw = await kvStore.get("correlation:services");
    if (!raw) {
      return jsonResult({ error: "No correlation data. Run 'mma index' with 2+ repos first." });
    }
    const parsed = JSON.parse(raw) as {
      links: unknown[];
      linchpins: Array<{ endpoint: string; [key: string]: unknown }>;
      orphanedServices: Array<{ endpoint: string; [key: string]: unknown }>;
    };

    let linchpins = parsed.linchpins;
    let orphanedServices = parsed.orphanedServices;

    if (endpoint) {
      const lower = endpoint.toLowerCase();
      linchpins = linchpins.filter((l) => l.endpoint.toLowerCase().includes(lower));
      orphanedServices = orphanedServices.filter((o) => o.endpoint.toLowerCase().includes(lower));
    }

    const selectedKind = kind ?? "all";
    const result: Record<string, unknown> = {};

    if (selectedKind === "linchpins" || selectedKind === "all") {
      result["linchpins"] = paginated(linchpins, offset ?? 0, limit ?? 50);
    }
    if (selectedKind === "orphaned" || selectedKind === "all") {
      result["orphanedServices"] = paginated(orphanedServices, offset ?? 0, limit ?? 50);
    }
    if (selectedKind === "all") {
      result["links"] = parsed.links;
    }

    return jsonResult(result);
  });

  // 9. Blast radius analysis
  server.registerTool("get_blast_radius", {
    description: "Compute the blast radius of changing one or more files: what other files would be affected via import and call dependencies.",
    inputSchema: {
      files: z.array(z.string()).describe("File paths to analyze the blast radius for"),
      repo: z.string().optional().describe("Filter to a specific repository name"),
      maxDepth: z.number().optional().describe("Max traversal depth (default 5)"),
      includeCallGraph: z.boolean().optional().describe("Include call graph edges in traversal (default true)"),
      crossRepo: z.boolean().optional().describe("Expand impact to downstream repos via cross-repo correlation (default false)"),
    },
  }, async ({ files, repo, maxDepth, includeCallGraph, crossRepo }) => {
    let crossRepoGraph: CrossRepoGraph | undefined;
    if (crossRepo) {
      const raw = await kvStore.get("correlation:graph");
      if (raw) {
        const parsed = JSON.parse(raw) as {
          edges: CrossRepoGraph["edges"];
          repoPairs: string[];
          downstreamMap: [string, string[]][];
          upstreamMap: [string, string[]][];
        };
        crossRepoGraph = deserializeGraph(parsed);
      }
    }
    // Compute PageRank scores for blast radius annotation
    const importEdges = await graphStore.getEdgesByKind("imports", repo);
    const prResult = computePageRank(importEdges);
    const result = await computeBlastRadius(files, graphStore, {
      maxDepth, includeCallGraph, repo, crossRepoGraph,
      pageRankScores: prResult.scores,
    }, searchStore);
    // Sort by score descending
    const sorted = {
      ...result,
      affectedFiles: [...result.affectedFiles].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
    };
    return jsonResult(sorted);
  });

  // Vulnerability reachability findings
  server.registerTool("get_vulnerability", {
    description: "List vulnerability reachability findings from the latest analysis. Shows which vulnerable dependencies are actually imported in the codebase.",
    inputSchema: {
      repo: z.string().optional().describe("Filter to a specific repository name"),
      severity: z.enum(["low", "moderate", "high", "critical"]).optional().describe("Filter by minimum severity level"),
      limit: z.number().optional().describe("Max results to return (default 20)"),
      offset: z.number().optional().describe("Offset for pagination (default 0)"),
    },
  }, async ({ repo, severity, limit, offset }) => {
    const maxResults = limit ?? 20;
    const skip = offset ?? 0;

    // Collect vuln SARIF from matching repos
    const allResults: import("@mma/core").SarifResult[] = [];
    const indexJson = await kvStore.get("sarif:latest:index");
    if (!indexJson) return jsonResult({ findings: [], total: 0 });

    const index = JSON.parse(indexJson) as { repos: string[] };
    const targetRepos = repo ? [repo] : index.repos;

    for (const r of targetRepos) {
      const json = await kvStore.get(`sarif:vuln:${r}`);
      if (json) {
        try {
          const results = JSON.parse(json) as import("@mma/core").SarifResult[];
          allResults.push(...results);
        } catch { /* skip malformed */ }
      }
    }

    // Filter by minimum severity
    const severityOrder = ["low", "moderate", "high", "critical"];
    const minIdx = severity ? severityOrder.indexOf(severity) : 0;
    const filtered = severity
      ? allResults.filter(r => severityOrder.indexOf(String(r.properties?.severity ?? "low")) >= minIdx)
      : allResults;

    // Paginate
    const paginated = filtered.slice(skip, skip + maxResults);
    return jsonResult({ findings: paginated, total: filtered.length, offset: skip, limit: maxResults });
  });

  // 13. Feature flag inventory
  server.registerTool("get_flag_inventory", {
    description: "List and search feature flags detected across indexed repositories. Supports filtering by repo, substring search, and pagination.",
    inputSchema: {
      repo: z.string().optional().describe("Filter to a specific repository name"),
      search: z.string().optional().describe("Substring to filter flag names by (case-insensitive)"),
      limit: z.number().optional().describe("Max results to return (default 50)"),
      offset: z.number().optional().describe("Number of results to skip for pagination (default 0)"),
    },
  }, async ({ repo, search, limit, offset }) => {
    const result = await getFlagInventory(kvStore, { repo, search, limit, offset });
    return jsonResult(result);
  });

  // 14. Feature flag impact analysis
  server.registerTool("get_flag_impact", {
    description: "Trace the impact of a feature flag: reverse BFS from flag locations through import/call graph to find affected files and services, with optional cross-repo expansion.",
    inputSchema: {
      flag: z.string().describe("Feature flag name (exact match tried first, then substring)"),
      repo: z.string().describe("Repository the flag belongs to"),
      maxDepth: z.number().optional().describe("Max traversal depth (default 5)"),
      includeCallGraph: z.boolean().optional().describe("Include call graph edges in traversal (default true)"),
      crossRepo: z.boolean().optional().describe("Expand impact to downstream repos via cross-repo correlation (default false)"),
    },
  }, async ({ flag, repo, maxDepth, includeCallGraph, crossRepo }) => {
    const intraResult = await computeFlagImpact(flag, repo, kvStore, graphStore, {
      maxDepth, includeCallGraph,
    });

    if (!crossRepo) {
      return jsonResult(intraResult);
    }

    // Cross-repo expansion using correlation graph
    const raw = await kvStore.get("correlation:graph");
    if (!raw) {
      return jsonResult({ ...intraResult, crossRepo: { error: "No correlation data available." } });
    }
    const parsed = JSON.parse(raw) as {
      edges: CrossRepoGraph["edges"];
      repoPairs: string[];
      downstreamMap: [string, string[]][];
      upstreamMap: [string, string[]][];
    };
    const graph = deserializeGraph(parsed);
    const allAffectedFiles = [
      ...intraResult.flagLocations,
      ...intraResult.affectedFiles.map((f) => f.path),
    ];
    const crossImpact = await computeCrossRepoImpact(allAffectedFiles, repo, graphStore, graph);
    return jsonResult({
      ...intraResult,
      crossRepo: {
        reposReached: crossImpact.reposReached,
        affectedAcrossRepos: Object.fromEntries(crossImpact.affectedAcrossRepos),
      },
    });
  });

  // 12a. Cross-repo model results (features, faults, catalog)
  server.registerTool("get_cross_repo_models", {
    description: "Get cross-repo model analysis results: shared feature flags, cascading fault links, and system service catalog. Requires 2+ repos indexed.",
    inputSchema: {
      kind: z.enum(["features", "faults", "catalog", "all"]).default("all").describe("Which model result to return"),
      repo: z.string().optional().describe("Filter results involving this repo"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      limit: z.number().int().min(1).max(200).default(50).describe("Max results per page"),
    },
  }, async ({ kind, repo, offset, limit }) => {
    const o = offset ?? 0;
    const l = limit ?? 50;
    const result: Record<string, unknown> = {};

    if (kind === "features" || kind === "all") {
      const raw = await kvStore.get("cross-repo:features");
      if (raw) {
        try {
          const data = JSON.parse(raw) as { sharedFlags: Array<{ name: string; repos: string[]; coordinated: boolean }> };
          let flags = data.sharedFlags;
          if (repo) flags = flags.filter((f) => f.repos.includes(repo));
          result.features = paginated(flags, o, l);
        } catch { result.features = { error: "Could not parse cross-repo:features" }; }
      }
    }

    if (kind === "faults" || kind === "all") {
      const raw = await kvStore.get("cross-repo:faults");
      if (raw) {
        try {
          const data = JSON.parse(raw) as { faultLinks: Array<{ endpoint: string; sourceRepo: string; targetRepo: string }> };
          let links = data.faultLinks;
          if (repo) links = links.filter((l) => l.sourceRepo === repo || l.targetRepo === repo);
          result.faults = paginated(links, o, l);
        } catch { result.faults = { error: "Could not parse cross-repo:faults" }; }
      }
    }

    if (kind === "catalog" || kind === "all") {
      const raw = await kvStore.get("cross-repo:catalog");
      if (raw) {
        try {
          const data = JSON.parse(raw) as { entries: Array<{ entry: { name: string }; repo: string; consumers?: string[]; producers?: string[] }> };
          let entries = data.entries;
          if (repo) entries = entries.filter((e) => e.repo === repo || e.consumers?.includes(repo) || e.producers?.includes(repo));
          result.catalog = paginated(entries, o, l);
        } catch { result.catalog = { error: "Could not parse cross-repo:catalog" }; }
      }
    }

    if (Object.keys(result).length === 0) {
      return jsonResult({ error: "No cross-repo model data. Run 'mma index' with 2+ repos first." });
    }

    return jsonResult(result);
  });

  // 12b. Cross-repo impact analysis
  server.registerTool("get_cross_repo_impact", {
    description: "Compute cross-repo impact of file changes: which files in the same repo and other repos are transitively affected",
    inputSchema: {
      files: z.array(z.string()).describe("File paths that are changing"),
      repo: z.string().describe("Repository the changed files belong to"),
    },
  }, async ({ files, repo }) => {
    const raw = await kvStore.get("correlation:graph");
    if (!raw) {
      return jsonResult({ error: "No correlation data. Run 'mma index' with 2+ repos first." });
    }
    const parsed = JSON.parse(raw) as {
      edges: CrossRepoGraph["edges"];
      repoPairs: string[];
      downstreamMap: [string, string[]][];
      upstreamMap: [string, string[]][];
    };
    const graph = deserializeGraph(parsed);
    const impact = await computeCrossRepoImpact(files, repo, graphStore, graph);
    return jsonResult({
      changedFiles: impact.changedFiles,
      changedRepo: impact.changedRepo,
      affectedWithinRepo: impact.affectedWithinRepo,
      affectedAcrossRepos: Object.fromEntries(impact.affectedAcrossRepos),
      reposReached: impact.reposReached,
    });
  });
}

function deserializeGraph(raw: {
  edges: CrossRepoGraph["edges"];
  repoPairs: string[];
  downstreamMap: [string, string[]][];
  upstreamMap: [string, string[]][];
}): CrossRepoGraph {
  return {
    edges: raw.edges,
    repoPairs: new Set(raw.repoPairs),
    downstreamMap: new Map(raw.downstreamMap.map(([k, v]) => [k, new Set(v)])),
    upstreamMap: new Map(raw.upstreamMap.map(([k, v]) => [k, new Set(v)])),
  };
}

/** Dispatch a routed query to the appropriate handler, returning structured data. */
async function dispatchRoute(
  route: string,
  decision: { readonly strippedQuery: string; readonly extractedEntities: readonly string[]; readonly repo?: string },
  stores: Stores,
): Promise<unknown> {
  const { graphStore, searchStore, kvStore } = stores;
  const q = decision.strippedQuery.toLowerCase();
  const repo = decision.repo;

  switch (route) {
    case "structural": {
      if (/\bcircular\b/.test(q)) {
        return await getCircularDeps(kvStore, repo);
      }
      if (decision.extractedEntities.length > 0) {
        const entity = decision.extractedEntities[0];
        if (!entity) {
          return { error: "No entity could be extracted from the query." };
        }
        const isCallees = /\bcallees?\b/.test(q) || /\bwhat does .+ call\b/.test(q);
        const isDeps = q.includes("depend");
        if (isDeps) {
          return await executeDependencyQuery(entity, graphStore, repo ? { maxDepth: 3, repo } : 3, searchStore);
        }
        if (isCallees) {
          return await executeCalleesQuery(entity, graphStore, repo, searchStore);
        }
        return await executeCallersQuery(entity, graphStore, repo, searchStore);
      }
      return { error: "No entity found in query for structural lookup." };
    }

    case "search": {
      const result = await executeSearchQuery(decision.strippedQuery, searchStore);
      const hits = repo
        ? result.results.filter((h) => h.metadata?.["repo"] === repo)
        : result.results;
      return { description: result.description, results: hits };
    }

    case "analytical": {
      return await getDiagnosticsForAnalytical(kvStore, decision);
    }

    case "architecture": {
      return await executeArchitectureQuery(graphStore, kvStore, repo);
    }

    case "pattern": {
      return await getPatterns(kvStore, q, repo);
    }

    case "documentation": {
      return await getDocumentation(kvStore, repo);
    }

    case "faulttree": {
      return await getFaultTrees(kvStore, repo);
    }

    case "metrics": {
      const moduleFilter = decision.extractedEntities.length > 0
        ? decision.extractedEntities[0]
        : undefined;
      return await getMetrics(kvStore, moduleFilter, repo);
    }

    case "blastradius": {
      if (decision.extractedEntities.length > 0) {
        return await computeBlastRadiusFromDispatch(decision.extractedEntities, graphStore, searchStore, repo);
      }
      return { error: "No files specified for blast radius analysis." };
    }

    case "flagimpact": {
      const entity = decision.extractedEntities[0];
      if (entity && repo) {
        return await computeFlagImpact(entity, repo, kvStore, graphStore);
      }
      return await getFlagInventory(kvStore, { repo, search: entity });
    }

    case "synthesis": {
      const entity = decision.extractedEntities[0];
      const entityLower = (entity ?? "").toLowerCase();
      const wantArch    = entityLower.includes("arch");
      const wantHealth  = entityLower.includes("health");
      const wantCatalog = entityLower.includes("catalog") || entityLower.includes("service");
      const wantSystem  = entityLower.includes("system") || entityLower.includes("overview");
      const wantAll     = !wantArch && !wantHealth && !wantCatalog && !wantSystem;

      type NarrationEntry = { key: string; kind: string; repo?: string; text: string };
      const narrations: NarrationEntry[] = [];

      const fetchKey = async (key: string, kind: string, repoName?: string): Promise<void> => {
        const raw = await kvStore.get(key);
        if (raw) narrations.push({ key, kind, repo: repoName, text: raw });
      };

      if (wantSystem || wantAll) {
        await fetchKey("narration:system", "system");
      }

      if (repo) {
        if (wantArch    || wantAll) await fetchKey(`narration:repo-arch:${repo}`, "repo-arch", repo);
        if (wantHealth  || wantAll) await fetchKey(`narration:health:${repo}`,    "health",    repo);
        if (wantCatalog || wantAll) await fetchKey(`narration:catalog:${repo}`,   "catalog",   repo);
      } else {
        // No repo filter — scan all keys for each kind
        const allKeys = await kvStore.keys("narration:");
        for (const key of allKeys) {
          if (key === "narration:system") continue; // already handled above
          const m = /^narration:(repo-arch|health|catalog):(.+)$/.exec(key);
          if (!m) continue;
          const kind = m[1]!;
          const repoName = m[2]!;
          const include =
            wantAll ||
            (wantArch    && kind === "repo-arch") ||
            (wantHealth  && kind === "health")    ||
            (wantCatalog && kind === "catalog");
          if (!include) continue;
          const raw = await kvStore.get(key);
          if (raw) narrations.push({ key, kind, repo: repoName, text: raw });
        }
      }

      if (narrations.length === 0) {
        return {
          narrations: [],
          message: "No narrations found. Run 'mma index' with --api-key to generate narrations.",
        };
      }
      return { narrations };
    }

    default:
      return { error: `Unknown route: ${route}` };
  }
}

async function getCircularDeps(kvStore: KVStore, repo?: string): Promise<unknown> {
  const keys = await kvStore.keys("circularDeps:");
  const results: Array<{ repo: string; cycles: string[][] }> = [];
  for (const key of keys) {
    const r = key.replace("circularDeps:", "");
    if (repo && r !== repo) continue;
    const json = await kvStore.get(key);
    if (!json) continue;
    try {
      results.push({ repo: r, cycles: JSON.parse(json) as string[][] });
    } catch { /* skip corrupted */ }
  }
  return { totalCycles: results.reduce((n, r) => n + r.cycles.length, 0), repos: results };
}

async function getPatterns(kvStore: KVStore, query: string, repo?: string): Promise<unknown> {
  const kindMap: Record<string, string> = {
    factory: "factory", factories: "factory",
    singleton: "singleton", singletons: "singleton",
    observer: "observer", observers: "observer",
    adapter: "adapter", adapters: "adapter",
    facade: "facade", facades: "facade",
    repository: "repository", repositories: "repository",
    middleware: "middleware", middlewares: "middleware",
    decorator: "decorator", decorators: "decorator",
  };
  let kindFilter: string | null = null;
  for (const [word, kind] of Object.entries(kindMap)) {
    if (query.includes(word)) { kindFilter = kind; break; }
  }

  const keys = await kvStore.keys("patterns:");
  const results: Array<{ repo: string; patterns: DetectedPattern[] }> = [];
  for (const key of keys) {
    const r = key.replace("patterns:", "");
    if (repo && r !== repo) continue;
    const json = await kvStore.get(key);
    if (!json) continue;
    try {
      let patterns = JSON.parse(json) as DetectedPattern[];
      if (kindFilter) patterns = patterns.filter((p) => p.kind === kindFilter);
      if (patterns.length > 0) results.push({ repo: r, patterns });
    } catch { /* skip corrupted */ }
  }
  return { kindFilter, total: results.reduce((n, r) => n + r.patterns.length, 0), repos: results };
}

async function getDocumentation(kvStore: KVStore, repo?: string): Promise<unknown> {
  const keys = await kvStore.keys("docs:functional:");
  const results: Array<{ repo: string; documentation: string }> = [];
  for (const key of keys) {
    const r = key.replace("docs:functional:", "");
    if (repo && r !== repo) continue;
    const docs = await kvStore.get(key);
    if (docs) results.push({ repo: r, documentation: docs });
  }
  return { found: results.length > 0, repos: results };
}

async function getFaultTrees(kvStore: KVStore, repo?: string): Promise<unknown> {
  const keys = await kvStore.keys("faultTrees:");
  const results: Array<{ repo: string; trees: FaultTree[] }> = [];
  for (const key of keys) {
    const r = key.replace("faultTrees:", "");
    if (repo && r !== repo) continue;
    const json = await kvStore.get(key);
    if (!json) continue;
    try {
      results.push({ repo: r, trees: JSON.parse(json) as FaultTree[] });
    } catch { /* skip corrupted */ }
  }
  return { total: results.reduce((n, r) => n + r.trees.length, 0), repos: results };
}

async function getDiagnosticsForAnalytical(
  kvStore: KVStore,
  decision: { readonly strippedQuery: string; readonly extractedEntities: readonly string[]; readonly repo?: string },
): Promise<unknown> {
  const sarifJson = await kvStore.get("sarif:latest");
  if (!sarifJson) return { error: "No analysis results available. Run 'mma index' first." };

  let sarif: SarifLog;
  try {
    sarif = JSON.parse(sarifJson) as SarifLog;
  } catch {
    return { error: "Stored SARIF data is corrupted. Re-run 'mma index' to regenerate." };
  }

  const stopWords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been",
    "do", "does", "did", "have", "has", "had", "will", "would",
    "can", "could", "should", "may", "might", "shall",
    "what", "which", "who", "whom", "where", "when", "why", "how",
    "that", "this", "these", "those", "it", "its",
    "in", "on", "at", "to", "for", "of", "with", "by", "from",
    "and", "or", "not", "no", "but", "if", "then", "so",
    "about", "any", "all", "some", "there", "my", "me", "show",
  ]);
  const keywords = decision.strippedQuery.toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));
  const entities = decision.extractedEntities;

  const categoryLevelFilter = resolveCategoryFilter(keywords);
  const categoryRuleFilter = resolveCategoryRuleFilter(keywords);
  const broadTerms = /^(?:diagnostics?|issues?|findings?|results?|problems?)$/;
  const isBroadQuery = !categoryLevelFilter && !categoryRuleFilter
    && keywords.some((kw) => broadTerms.test(kw));

  const matching = sarif.runs.flatMap((r) =>
    r.results.filter((res) => {
      if (decision.repo) {
        const locRepo = res.locations?.[0]?.logicalLocations?.[0]?.properties?.["repo"];
        if (locRepo !== decision.repo) return false;
      }
      if (isBroadQuery) return true;
      if (categoryLevelFilter && res.level !== categoryLevelFilter) return false;
      if (categoryRuleFilter && !res.ruleId?.startsWith(categoryRuleFilter)) return false;
      if (categoryLevelFilter || categoryRuleFilter) return true;

      const text = `${res.ruleId} ${res.message.text}`.toLowerCase();
      if (entities.some((e) => text.includes(e.toLowerCase()))) return true;
      if (keywords.length === 0) return false;
      const hits = keywords.filter((kw) => text.includes(kw)).length;
      return hits >= Math.max(1, Math.ceil(keywords.length / 2));
    }),
  );

  return { total: matching.length, results: matching.slice(0, 50) };
}

function resolveCategoryFilter(keywords: string[]): string | null {
  for (const kw of keywords) {
    if (/^warnings?$/.test(kw)) return "warning";
    if (/^errors?$/.test(kw)) return "error";
    if (/^notes?$/.test(kw)) return "note";
  }
  return null;
}

function resolveCategoryRuleFilter(keywords: string[]): string | null {
  for (const kw of keywords) {
    if (/^(?:faults?|unhandled|gaps?|missing)$/.test(kw)) return "fault/";
    if (/^(?:configs?|flags?|interactions?|untested)$/.test(kw)) return "config/";
  }
  return null;
}

async function getMetrics(kvStore: KVStore, moduleFilter?: string, repo?: string): Promise<unknown> {
  const keys = await kvStore.keys("metrics:");
  // Filter to metrics keys (not metricsSummary keys)
  const metricsKeys = keys.filter((k) => !k.startsWith("metricsSummary:"));
  const results: Array<{ repo: string; modules?: ModuleMetrics[]; summary?: RepoMetricsSummary }> = [];

  for (const key of metricsKeys) {
    const r = key.replace("metrics:", "");
    if (repo && r !== repo) continue;
    const json = await kvStore.get(key);
    if (!json) continue;
    try {
      let modules = JSON.parse(json) as ModuleMetrics[];
      if (moduleFilter) {
        modules = modules.filter((m) => m.module.includes(moduleFilter));
      }
      const summaryJson = await kvStore.get(`metricsSummary:${r}`);
      const summary = summaryJson ? (JSON.parse(summaryJson) as RepoMetricsSummary) : undefined;
      results.push({ repo: r, modules: moduleFilter ? modules : undefined, summary });
    } catch { /* skip corrupted */ }
  }

  if (moduleFilter) {
    const allModules = results.flatMap((r) => r.modules ?? []);
    return { moduleFilter, total: allModules.length, modules: allModules };
  }
  return { total: results.length, repos: results };
}

async function computeBlastRadiusFromDispatch(
  entities: readonly string[],
  graphStore: GraphStore,
  searchStore: SearchStore,
  repo?: string,
): Promise<unknown> {
  return await computeBlastRadius(
    [...entities],
    graphStore,
    { repo },
    searchStore,
  );
}
