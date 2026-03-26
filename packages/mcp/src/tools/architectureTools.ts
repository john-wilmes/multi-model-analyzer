import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findDependencyPaths, computeCrossRepoImpact } from "@mma/correlation";
import type { CrossRepoGraph } from "@mma/correlation";
import { executeArchitectureQuery } from "@mma/query";
import { z } from "zod";
import { jsonResult, paginated, deserializeGraph } from "./helpers.js";
import type { Stores } from "./helpers.js";

export function registerArchitectureTools(server: McpServer, stores: Stores): void {
  const { graphStore, kvStore } = stores;

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
        result["linksTruncated"] = { shown: MAX_LINKS, total: parsed.links.length, note: "Truncated to 100 entries. Request a specific kind (linchpins, packages, orphaned) for focused results." };
      }
    }

    return jsonResult(result);
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
}
