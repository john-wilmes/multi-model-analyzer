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
}
