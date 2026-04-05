import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  routeQuery,
  executeSearchQuery,
  executeCallersQuery,
  executeCalleesQuery,
  executeDependencyQuery,
} from "@mma/query";
import { z } from "zod";
import { jsonResult, paginated } from "./helpers.js";
import type { Stores } from "./helpers.js";
import { dispatchRoute, getMetrics } from "./dispatch.js";

export function registerCoreQueryTools(server: McpServer, stores: Stores): void {
  const { graphStore, searchStore, kvStore } = stores;

  // 1. Natural language query (catch-all)
  server.registerTool("query", {
    description: "Route a natural language question to the appropriate analysis backend. Supports structural queries (callers, callees, dependencies, circular deps), search, diagnostics, architecture, patterns, documentation, and fault trees. Routes automatically to the best tool. For precise results, call the specific tool directly once you know what you need.",
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
    }, undefined, ["For more precise results, call the specific tool directly (search, get_callers, get_dependencies, etc.)."]);
  });

  // 2. Full-text symbol search
  server.registerTool("search", {
    description: "Search for symbols, files, and code across indexed repositories using BM25 full-text search. Start here to find exact FQNs (e.g. src/auth.ts#AuthService.signIn) before calling get_callers, get_callees, or get_dependencies.",
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
    const searchHints = page.results.length > 0
      ? ["Use the 'id' field from results as the 'symbol' input for get_callers or get_callees."]
      : ["No results — try broader terms or omit the repo filter."];
    return jsonResult(page, undefined, searchHints);
  });

  // 3. Who calls a symbol
  server.registerTool("get_callers", {
    description: "Find all callers of a symbol. Best results with fully qualified names like 'src/auth.ts#AuthService.signIn' or 'file.ts#ClassName'. Short names like 'signIn' use BM25 fallback (less precise). Use 'search' first to find the exact symbol ID if unsure. Follow with get_blast_radius on caller files to see change scope.",
    inputSchema: {
      symbol: z.string().describe("Symbol FQN (e.g. 'src/auth.ts#AuthService.signIn') or short name (BM25 fallback)"),
      repo: z.string().optional().describe("Filter to a specific repository name"),
    },
  }, async ({ symbol, repo }) => {
    const result = await executeCallersQuery(symbol, graphStore, repo, searchStore);
    const callerHints = result.edges.length > 0
      ? ["Call get_blast_radius on caller files to understand change scope."]
      : ["No callers found — the symbol may be unused or only called dynamically."];
    return jsonResult(result, undefined, callerHints);
  });

  // 4. What does a symbol call
  server.registerTool("get_callees", {
    description: "Find all symbols called by a given symbol. Best results with fully qualified names like 'src/auth.ts#AuthService.signIn'. Short names use BM25 fallback. Use 'search' first to find the exact symbol ID if unsure. Follow with get_dependencies for the full transitive subgraph.",
    inputSchema: {
      symbol: z.string().describe("Symbol FQN (e.g. 'src/auth.ts#AuthService.signIn') or short name (BM25 fallback)"),
      repo: z.string().optional().describe("Filter to a specific repository name"),
    },
  }, async ({ symbol, repo }) => {
    const result = await executeCalleesQuery(symbol, graphStore, repo, searchStore);
    const calleeHints = result.edges.length > 0
      ? ["Call get_dependencies for the full transitive dependency subgraph."]
      : undefined;
    return jsonResult(result, undefined, calleeHints);
  });

  // 5. Dependency graph traversal
  server.registerTool("get_dependencies", {
    description: "Traverse the dependency graph from a symbol or module. Returns edges within maxDepth hops. Pair with get_blast_radius to understand change impact.",
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
    const depHints = result.edges.length > 0
      ? ["Call get_blast_radius on leaf nodes to assess impact depth."]
      : undefined;
    return jsonResult(result, undefined, depHints);
  });

  // 8. Module instability metrics
  server.registerTool("get_metrics", {
    description: "Get module instability metrics (coupling, abstractness, distance from main sequence) for indexed repositories. Low instability (I < 0.3) with low abstractness (A < 0.3) = pain-zone module (concrete, hard to change) — follow with get_blast_radius.",
    inputSchema: {
      repo: z.string().optional().describe("Filter to a specific repository name"),
      module: z.string().optional().describe("Filter to a specific module (file path)"),
      limit: z.number().optional().describe("Max repos or modules to return (default all)"),
      offset: z.number().optional().describe("Number of results to skip for pagination (default 0)"),
    },
  }, async ({ repo, module, limit, offset }) => {
    const data = await getMetrics(kvStore, module, repo);
    const hasHighInstability = (items: unknown[]): boolean =>
      items.some((m) => {
        const mod = m as Record<string, unknown>;
        const instability = typeof mod["instability"] === "number" ? mod["instability"] : 0;
        return instability > 0.7;
      });
    const metricsHint = "High-instability modules detected. Call get_blast_radius on these files to assess change risk.";
    if (module && Array.isArray((data as Record<string, unknown>).modules)) {
      const modules = (data as { modules: unknown[] }).modules;
      const page = paginated(modules, offset ?? 0, limit ?? modules.length);
      const hints = hasHighInstability(page.results) ? [metricsHint] : undefined;
      return jsonResult({ moduleFilter: module, ...page }, undefined, hints);
    }
    if (Array.isArray((data as Record<string, unknown>).repos)) {
      const repos = (data as { repos: unknown[] }).repos;
      if (limit || offset) {
        const page = paginated(repos, offset ?? 0, limit ?? repos.length);
        const hints = hasHighInstability(page.results) ? [metricsHint] : undefined;
        return jsonResult({ ...page }, undefined, hints);
      }
    }
    const links = repo
      ? [{ uri: `mma://repo/${repo}/metrics`, name: `${repo} metrics`, description: "Full metrics for this repository" }]
      : undefined;
    // Check for high instability in repo-level or flat data
    const dataObj = data as Record<string, unknown>;
    const repoItems = Array.isArray(dataObj["repos"]) ? (dataObj["repos"] as unknown[]) : [];
    const moduleItems = Array.isArray(dataObj["modules"]) ? (dataObj["modules"] as unknown[]) : [];
    const allItems = [...repoItems, ...moduleItems];
    const hints = allItems.length > 0 && hasHighInstability(allItems) ? [metricsHint] : undefined;
    return jsonResult(data, links, hints);
  });
}
