import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSarifResultsPaginated } from "@mma/storage";
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
import { z } from "zod";
import {
  jsonResult,
  paginated,
  deserializeGraph,
} from "./tools/helpers.js";
export type { IndexRepoResult, Stores, ContentItem, ToolResult } from "./tools/helpers.js";
import type { Stores } from "./tools/helpers.js";
import { dispatchRoute, getMetrics } from "./tools/dispatch.js";

export function registerTools(server: McpServer, stores: Stores): void {
  const { graphStore, searchStore, kvStore, mirrorDir, indexRepo } = stores;

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
    description: "Find all callers of a symbol. Best results with fully qualified names like 'src/auth.ts#AuthService.signIn' or 'file.ts#ClassName'. Short names like 'signIn' use BM25 fallback (less precise). Use 'search' first to find the exact symbol ID if unsure.",
    inputSchema: {
      symbol: z.string().describe("Symbol FQN (e.g. 'src/auth.ts#AuthService.signIn') or short name (BM25 fallback)"),
      repo: z.string().optional().describe("Filter to a specific repository name"),
    },
  }, async ({ symbol, repo }) => {
    const result = await executeCallersQuery(symbol, graphStore, repo, searchStore);
    return jsonResult(result);
  });

  // 4. What does a symbol call
  server.registerTool("get_callees", {
    description: "Find all symbols called by a given symbol. Best results with fully qualified names like 'src/auth.ts#AuthService.signIn'. Short names use BM25 fallback. Use 'search' first to find the exact symbol ID if unsure.",
    inputSchema: {
      symbol: z.string().describe("Symbol FQN (e.g. 'src/auth.ts#AuthService.signIn') or short name (BM25 fallback)"),
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
    // Truncate large arrays to prevent 20K+ token responses
    const MAX_EDGES = 50;
    const MAX_TOPOLOGY = 30;
    const truncated: Record<string, unknown> = {
      repos: result.repos,
      description: result.description,
    };
    if (result.crossRepoEdges.length > MAX_EDGES) {
      // Sort by count descending, keep top N
      const sorted = [...result.crossRepoEdges].sort((a, b) => b.count - a.count);
      truncated["crossRepoEdges"] = sorted.slice(0, MAX_EDGES);
      truncated["crossRepoEdgesTruncated"] = { shown: MAX_EDGES, total: result.crossRepoEdges.length, note: "Sorted by import count desc. Use get_cross_repo_graph for full edge list." };
    } else {
      truncated["crossRepoEdges"] = result.crossRepoEdges;
    }
    if (result.serviceTopology.length > MAX_TOPOLOGY) {
      // Sort deterministically by sourceRepo+sourceFile before truncating (no count field on ServiceLink)
      const sortedTopology = [...result.serviceTopology].sort((a, b) => {
        const aKey = `${(a as { sourceRepo?: string }).sourceRepo ?? ""}:${(a as { sourceFile?: string }).sourceFile ?? ""}`;
        const bKey = `${(b as { sourceRepo?: string }).sourceRepo ?? ""}:${(b as { sourceFile?: string }).sourceFile ?? ""}`;
        return aKey.localeCompare(bKey) || JSON.stringify(a).localeCompare(JSON.stringify(b));
      });
      truncated["serviceTopology"] = sortedTopology.slice(0, MAX_TOPOLOGY);
      truncated["serviceTopologyTruncated"] = { shown: MAX_TOPOLOGY, total: result.serviceTopology.length, note: "Results are sorted alphabetically by sourceRepo:sourceFile. Use get_service_correlation for full service topology." };
    } else {
      truncated["serviceTopology"] = result.serviceTopology;
    }
    return jsonResult(truncated);
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

    if (total === 0 && level) {
      // Check if other levels have data for this repo
      const { total: anyTotal } = await getSarifResultsPaginated(kvStore, { repo, limit: 1, offset: 0 });
      if (anyTotal > 0) {
        return jsonResult({
          total: 0, returned: 0, offset: offset ?? 0, hasMore: false, results: [],
          note: `No '${level}'-level findings${repo ? ` for ${repo}` : ""}. There are ${anyTotal} findings at other severity levels — try without the level filter.`,
        });
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

    // Bug A: repoCount should be derived from filteredEdges, not repoPairs (which is unfiltered)
    const filteredRepoCount = new Set(filteredEdges.flatMap((e) => [e.sourceRepo, e.targetRepo])).size;

    // Bug B: when repo filter is active, restrict maps to only relevant entries
    const downstreamEntries = [...graph.downstreamMap.entries()];
    const upstreamEntries = [...graph.upstreamMap.entries()];
    const filteredDownstream = repo
      ? downstreamEntries.filter(([k, v]) => k === repo || v.has(repo))
      : downstreamEntries;
    const filteredUpstream = repo
      ? upstreamEntries.filter(([k, v]) => k === repo || v.has(repo))
      : upstreamEntries;

    // Filter repoPairs to only include pairs visible in filteredEdges
    const filteredRepoSet = new Set(filteredEdges.flatMap((e) => [e.sourceRepo, e.targetRepo]));
    const filteredRepoPairs = repo
      ? [...graph.repoPairs].filter((pair) => {
          const [a, b] = pair.split("->");
          return a && b && filteredRepoSet.has(a) && filteredRepoSet.has(b);
        })
      : [...graph.repoPairs];

    // Build a scoped graph for path discovery when filtering by repo
    const scopedGraph = repo
      ? {
          ...graph,
          edges: filteredEdges,
          repoPairs: new Set(filteredRepoPairs),
          downstreamMap: new Map(filteredDownstream),
          upstreamMap: new Map(filteredUpstream),
        }
      : graph;

    const result: Record<string, unknown> = {
      repoCount: filteredRepoCount,
      edgeCount: filteredEdges.length,
      repoPairs: filteredRepoPairs,
      edges: filteredEdges,
      downstreamMap: Object.fromEntries(filteredDownstream.map(([k, v]) => [k, [...v]])),
      upstreamMap: Object.fromEntries(filteredUpstream.map(([k, v]) => [k, [...v]])),
    };

    if (includePaths && filteredEdges.length > 0) {
      const repoList = [...filteredRepoSet];
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
              const found = findDependencyPaths(src, tgt, scopedGraph);
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
    description: "Get cross-repo service correlation: linchpin services/packages with high cross-repo coupling and orphaned services",
    inputSchema: {
      endpoint: z.string().optional().describe("Filter by endpoint or package name substring (case-insensitive)"),
      kind: z.enum(["linchpins", "packages", "orphaned", "all"]).optional().describe("Which subset to return: linchpins (HTTP endpoints), packages (shared packages), orphaned, or all (default: all)"),
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
      packageLinchpins?: Array<{ packageName: string; [key: string]: unknown }>;
      orphanedServices: Array<{ endpoint: string; [key: string]: unknown }>;
    };

    // Filter template-literal URLs (test harness noise like ${MAILPIT_URL}/...)
    let linchpins = parsed.linchpins.filter((l) => !l.endpoint.includes("${"));
    let packageLinchpins = parsed.packageLinchpins ?? [];
    let orphanedServices = parsed.orphanedServices.filter((o) => !o.endpoint.includes("${"));

    if (endpoint) {
      const lower = endpoint.toLowerCase();
      linchpins = linchpins.filter((l) => l.endpoint.toLowerCase().includes(lower));
      packageLinchpins = packageLinchpins.filter((p) => p.packageName.toLowerCase().includes(lower));
      orphanedServices = orphanedServices.filter((o) => o.endpoint.toLowerCase().includes(lower));
    }

    const selectedKind = kind ?? "all";
    const result: Record<string, unknown> = {};

    if (selectedKind === "linchpins" || selectedKind === "all") {
      result["linchpins"] = paginated(linchpins, offset ?? 0, limit ?? 50);
    }
    if (selectedKind === "packages" || selectedKind === "all") {
      result["packageLinchpins"] = paginated(packageLinchpins, offset ?? 0, limit ?? 50);
    }
    if (selectedKind === "orphaned" || selectedKind === "all") {
      result["orphanedServices"] = paginated(orphanedServices, offset ?? 0, limit ?? 50);
    }
    if (selectedKind === "all") {
      const MAX_LINKS = 100;
      result["links"] = parsed.links.length > MAX_LINKS
        ? parsed.links.slice(0, MAX_LINKS)
        : parsed.links;
      if (parsed.links.length > MAX_LINKS) {
        result["linksTruncated"] = { shown: MAX_LINKS, total: parsed.links.length, note: "Truncated to 100 entries. Request a specific kind (linchpins, packages, orphanedServices) for focused results." };
      }
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
    let crossRepoWarning: string | undefined;
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
      } else {
        crossRepoWarning = "crossRepo=true but no correlation data found. Run 'mma index' with 2+ repos to enable cross-repo blast radius.";
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
    const sorted: Record<string, unknown> = {
      changedFiles: result.changedFiles,
      affectedFiles: [...result.affectedFiles].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
      totalAffected: result.totalAffected,
      maxDepth: result.maxDepth,
      description: result.description,
    };
    // Serialize crossRepoAffected Map as plain object
    if (result.crossRepoAffected && result.crossRepoAffected.size > 0) {
      const crossRepoObj: Record<string, unknown[]> = {};
      for (const [r, affected] of result.crossRepoAffected) {
        crossRepoObj[r] = affected;
      }
      sorted["crossRepoAffected"] = crossRepoObj;
      const totalCross = [...result.crossRepoAffected.values()].reduce((s, a) => s + a.length, 0);
      sorted["description"] = `${result.description} Plus ${totalCross} cross-repo files in ${result.crossRepoAffected.size} downstream repo(s).`;
    } else if (crossRepo && crossRepoGraph) {
      sorted["crossRepoAffected"] = {};
      sorted["crossRepoNote"] = "Cross-repo graph available but no downstream files matched the changed files. The changed files may not be consumed by other repos.";
    }
    if (crossRepoWarning) {
      sorted["crossRepoWarning"] = crossRepoWarning;
    }
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
    if (!indexJson) return jsonResult({ findings: [], total: 0, note: "No analysis data. Run 'mma index' first." });

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

    if (allResults.length === 0) {
      return jsonResult({
        findings: [], total: 0, offset: skip, limit: maxResults,
        note: "No vulnerability findings. Ensure 'npm audit --json' data is available during indexing. Vulnerability reachability requires npm audit output to be present in the repo.",
      });
    }

    // Filter by minimum severity
    const severityOrder = ["low", "moderate", "high", "critical"];
    const minIdx = severity ? severityOrder.indexOf(severity) : 0;
    const filtered = severity
      ? allResults.filter(r => severityOrder.indexOf(String((r.properties?.severity as string | undefined) ?? "low").toLowerCase()) >= minIdx)
      : allResults;

    // Paginate
    const paginatedResults = filtered.slice(skip, skip + maxResults);
    return jsonResult({ findings: paginatedResults, total: filtered.length, offset: skip, limit: maxResults });
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
  }, async ({ kind: rawKind, repo, offset, limit }) => {
    const kind = typeof rawKind === "string" ? rawKind.toLowerCase() as typeof rawKind : "all";
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

  // 15. Scan GitHub org for repo candidates
  server.registerTool("scan_org", {
    description: "Scan a GitHub organization to discover repositories. Results are cached in KV and repos are registered as indexing candidates.",
    inputSchema: {
      org: z.string().describe("GitHub organization name"),
      excludeForks: z.boolean().optional().describe("Exclude forked repos (default: true)"),
      excludeArchived: z.boolean().optional().describe("Exclude archived repos (default: true)"),
      languages: z.array(z.string()).optional().describe("Filter to repos with these primary languages"),
    },
  }, async ({ org, excludeForks, excludeArchived, languages }) => {
    const { scanGitHubOrg } = await import("@mma/ingestion");
    const { RepoStateManager } = await import("@mma/correlation");

    const result = await scanGitHubOrg({ org, excludeForks, excludeArchived, languages });

    // Cache the scan result
    await kvStore.set(`org-scan:${org}`, JSON.stringify(result));

    // Register all repos as candidates
    const stateManager = new RepoStateManager(kvStore);
    let newCount = 0;
    for (const repo of result.repos) {
      const existing = await stateManager.get(repo.name);
      if (!existing) {
        await stateManager.addCandidate(
          { name: repo.name, url: repo.url, defaultBranch: repo.defaultBranch, language: repo.language ?? undefined },
          "org-scan",
        );
        newCount++;
      }
    }

    return jsonResult({
      org,
      totalRepos: result.totalReposInOrg,
      matchingRepos: result.repos.length,
      newCandidates: newCount,
      repos: result.repos.map(r => ({
        name: r.name,
        language: r.language,
        stars: r.starCount,
        updatedAt: r.updatedAt,
      })),
    });
  });

  // 16. Get repos in a given state (candidate, indexed, ignored, indexing)
  server.registerTool("get_repo_candidates", {
    description: "Get repos that are candidates for indexing, with their connection info and discovery source.",
    inputSchema: {
      status: z.enum(["candidate", "indexed", "ignored", "indexing"]).optional().describe("Filter by status (default: candidate)"),
    },
  }, async ({ status }) => {
    const { RepoStateManager } = await import("@mma/correlation");
    const stateManager = new RepoStateManager(kvStore);

    const filterStatus = status ?? "candidate";
    const repos = await stateManager.getByStatus(filterStatus as Parameters<typeof stateManager.getByStatus>[0]);
    const summary = await stateManager.summary();

    return jsonResult({
      status: filterStatus,
      count: repos.length,
      summary,
      repos: repos.map(r => ({
        name: r.name,
        url: r.url,
        language: r.language,
        discoveredVia: r.discoveredVia,
        connectionCount: r.connectionCount,
        discoveredAt: r.discoveredAt,
        indexedAt: r.indexedAt,
      })),
    });
  });

  // 17. Index a single repository (clone + full pipeline)
  server.registerTool("index_repo", {
    description: "Index a single repository. Clones (if needed), runs the full analysis pipeline, and updates cross-repo correlations.",
    inputSchema: {
      name: z.string().describe("Repository name (must be a registered candidate or provide url)"),
      url: z.string().optional().describe("Clone URL (uses stored URL if repo is already a candidate)"),
      branch: z.string().optional().describe("Branch to index (default: main)"),
    },
  }, async ({ name, url, branch }) => {
    const { RepoStateManager } = await import("@mma/correlation");
    const stateManager = new RepoStateManager(kvStore);

    // Get or create repo state
    const state = await stateManager.get(name);
    const repoUrl = url ?? state?.url;
    if (!repoUrl) {
      return jsonResult({ error: `No URL for repo "${name}". Provide url parameter or scan an org first.` });
    }

    if (!state) {
      await stateManager.addCandidate(
        { name, url: repoUrl, defaultBranch: branch },
        "user-selected",
      );
    } else if (state.status !== "candidate") {
      return jsonResult({ error: `Repo "${name}" is in "${state.status}" state, not "candidate".` });
    }

    await stateManager.startIndexing(name);

    try {
      const { cloneOrFetch } = await import("@mma/ingestion");
      const resolvedMirrorDir = mirrorDir ?? "./mirrors";

      // Clone or fetch the repository
      await cloneOrFetch(repoUrl, name, { mirrorDir: resolvedMirrorDir, branch });
      const localPath = join(resolvedMirrorDir, `${name}.git`);

      // Run full pipeline if indexRepo callback is wired up by the CLI
      if (indexRepo) {
        const result = await indexRepo({ name, localPath, bare: true });
        await stateManager.markIndexed(name);
        return jsonResult({
          status: "indexed",
          name,
          hadChanges: result.hadChanges,
          totalFiles: result.totalFiles,
          totalSarifResults: result.totalSarifResults,
        });
      }

      // Fallback: clone only (MCP server started without an indexRepo callback)
      await stateManager.markIndexed(name);
      return jsonResult({
        status: "cloned",
        name,
        message: `Repository "${name}" cloned but full analysis requires the MCP server to be started with indexRepo support. Run "mma index" via CLI for complete analysis.`,
      });
    } catch (err) {
      // Reset state back to "candidate" so the repo can be retried
      try {
        await stateManager.resetToCandidate(name);
      } catch { /* best-effort reset */ }
      return jsonResult({
        status: "failed",
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 18. Mark a repo as ignored
  server.registerTool("ignore_repo", {
    description: "Mark a repository as ignored so it won't be suggested for indexing.",
    inputSchema: {
      name: z.string().describe("Repository name to ignore"),
    },
  }, async ({ name }) => {
    const { RepoStateManager } = await import("@mma/correlation");
    const stateManager = new RepoStateManager(kvStore);

    const state = await stateManager.get(name);
    if (!state) {
      return jsonResult({ error: `Repo "${name}" not found in state.` });
    }

    try {
      await stateManager.markIgnored(name);
      return jsonResult({ status: "ignored", name });
    } catch (err) {
      return jsonResult({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 19. Full indexing state snapshot
  server.registerTool("get_indexing_state", {
    description: "Get the full indexing state machine snapshot: all repos with their status, discovery source, and connection counts.",
    inputSchema: {},
  }, async () => {
    const { RepoStateManager } = await import("@mma/correlation");
    const stateManager = new RepoStateManager(kvStore);

    const all = await stateManager.getAll();
    const summary = await stateManager.summary();

    return jsonResult({
      summary,
      repos: all.map(r => ({
        name: r.name,
        status: r.status,
        discoveredVia: r.discoveredVia,
        connectionCount: r.connectionCount,
        discoveredAt: r.discoveredAt,
        indexedAt: r.indexedAt,
        ignoredAt: r.ignoredAt,
      })),
    });
  });

  // 20. Diff org scan against known state to find new repos
  server.registerTool("check_new_repos", {
    description: "Re-scan a GitHub org and diff against known state to find newly added repos.",
    inputSchema: {
      org: z.string().describe("GitHub organization name"),
    },
  }, async ({ org }) => {
    const { diffOrgScan } = await import("./wake-up.js");
    const result = await diffOrgScan(org, kvStore);
    return jsonResult(result);
  });
}
