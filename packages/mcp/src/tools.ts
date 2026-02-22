import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphStore, SearchStore, KVStore } from "@mma/storage";
import type { DetectedPattern, FaultTree, SarifLog } from "@mma/core";
import {
  routeQuery,
  executeSearchQuery,
  executeCallersQuery,
  executeCalleesQuery,
  executeDependencyQuery,
  executeArchitectureQuery,
  computeBlastRadius,
} from "@mma/query";
import type { ModuleMetrics, RepoMetricsSummary } from "@mma/core";
import { z } from "zod";

interface Stores {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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
    },
  }, async ({ query, repo, limit }) => {
    const result = await executeSearchQuery(query, searchStore, limit ?? 10);
    const hits = repo
      ? result.results.filter((h) => h.metadata?.["repo"] === repo)
      : result.results;
    return jsonResult({
      description: repo
        ? `${hits.length} results (filtered to repo: ${repo})`
        : result.description,
      results: hits,
    });
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
    },
  }, async ({ query, repo, level, limit }) => {
    const sarifJson = await kvStore.get("sarif:latest");
    if (!sarifJson) {
      return jsonResult({ error: "No analysis results available. Run 'mma index' first.", results: [] });
    }

    let sarif: SarifLog;
    try {
      sarif = JSON.parse(sarifJson) as SarifLog;
    } catch {
      return jsonResult({ error: "Stored SARIF data is corrupted. Re-run 'mma index' to regenerate.", results: [] });
    }

    const keywords = query
      ? query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
      : [];

    const matching = sarif.runs.flatMap((r) =>
      r.results.filter((res) => {
        if (repo) {
          const locRepo = res.locations?.[0]?.logicalLocations?.[0]?.properties?.["repo"];
          if (locRepo !== repo) return false;
        }
        if (level && res.level !== level) return false;
        if (keywords.length > 0) {
          const text = `${res.ruleId} ${res.message.text}`.toLowerCase();
          const hits = keywords.filter((kw) => text.includes(kw)).length;
          if (hits < Math.max(1, Math.ceil(keywords.length / 2))) return false;
        }
        return true;
      }),
    );

    const cap = limit ?? 50;
    return jsonResult({
      total: matching.length,
      returned: Math.min(matching.length, cap),
      results: matching.slice(0, cap),
    });
  });
  // 8. Module instability metrics
  server.registerTool("get_metrics", {
    description: "Get module instability metrics (coupling, abstractness, distance from main sequence) for indexed repositories.",
    inputSchema: {
      repo: z.string().optional().describe("Filter to a specific repository name"),
      module: z.string().optional().describe("Filter to a specific module (file path)"),
    },
  }, async ({ repo, module }) => {
    return jsonResult(await getMetrics(kvStore, module, repo));
  });

  // 9. Blast radius analysis
  server.registerTool("get_blast_radius", {
    description: "Compute the blast radius of changing one or more files: what other files would be affected via import and call dependencies.",
    inputSchema: {
      files: z.array(z.string()).describe("File paths to analyze the blast radius for"),
      repo: z.string().optional().describe("Filter to a specific repository name"),
      maxDepth: z.number().optional().describe("Max traversal depth (default 5)"),
      includeCallGraph: z.boolean().optional().describe("Include call graph edges in traversal (default true)"),
    },
  }, async ({ files, repo, maxDepth, includeCallGraph }) => {
    const result = await computeBlastRadius(files, graphStore, {
      maxDepth, includeCallGraph, repo,
    }, searchStore);
    return jsonResult(result);
  });
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
        const entity = decision.extractedEntities[0]!;
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

    case "synthesis": {
      return { error: "Synthesis queries require tier 4 (Sonnet) -- not yet implemented." };
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
