import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getFlagInventory, computeFlagImpact } from "@mma/query";
import type { CrossRepoGraph } from "@mma/correlation";
import { computeCrossRepoImpact } from "@mma/correlation";
import { z } from "zod";
import { jsonResult, deserializeGraph } from "./helpers.js";
import type { Stores } from "./helpers.js";

export function registerPatternsTools(server: McpServer, stores: Stores): void {
  const { graphStore, kvStore } = stores;

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

  // 23. Design pattern detection results
  server.registerTool("get_patterns", {
    description: "Get detected design patterns (adapter, facade, observer, factory, singleton, repository, middleware, decorator) across indexed repositories.",
    inputSchema: {
      repo: z.string().optional().describe("Filter to a specific repository name"),
      pattern: z.string().optional().describe("Filter by pattern type name (case-insensitive substring match)"),
    },
  }, async ({ repo, pattern }) => {
    if (repo) {
      const json = await kvStore.get(`patterns:${repo}`);
      if (!json) {
        return jsonResult({ repo, patterns: {}, note: `No pattern data for "${repo}". Run 'mma index' first.` });
      }
      try {
        const data = JSON.parse(json) as Record<string, unknown>;
        if (pattern) {
          const lower = pattern.toLowerCase();
          const filtered: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(data)) {
            if (key.toLowerCase().includes(lower)) {
              filtered[key] = value;
            }
          }
          return jsonResult({ repo, patterns: filtered });
        }
        return jsonResult({ repo, patterns: data });
      } catch {
        return jsonResult({ repo, patterns: {}, error: "Could not parse pattern data" });
      }
    }

    // All repos
    const keys = await kvStore.keys("patterns:");
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const keyRepo = key.slice("patterns:".length);
      const json = await kvStore.get(key);
      if (json) {
        try {
          const data = JSON.parse(json) as Record<string, unknown>;
          if (pattern) {
            const lower = pattern.toLowerCase();
            const filtered: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(data)) {
              if (k.toLowerCase().includes(lower)) {
                filtered[k] = v;
              }
            }
            if (Object.keys(filtered).length > 0) {
              result[keyRepo] = filtered;
            }
          } else {
            result[keyRepo] = data;
          }
        } catch { /* skip malformed */ }
      }
    }

    if (Object.keys(result).length === 0) {
      return jsonResult({
        patterns: {},
        note: "No pattern data available. Run 'mma index' first.",
      });
    }

    return jsonResult({ repos: result });
  });
}
