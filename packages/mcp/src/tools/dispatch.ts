import type { GraphStore, SearchStore, KVStore } from "@mma/storage";
import type { DetectedPattern, FaultTree, SarifLog, ModuleMetrics, RepoMetricsSummary } from "@mma/core";
import {
  executeSearchQuery,
  executeCallersQuery,
  executeCalleesQuery,
  executeDependencyQuery,
  executeArchitectureQuery,
  computeBlastRadius,
  getFlagInventory,
  computeFlagImpact,
} from "@mma/query";
import type { Stores } from "./helpers.js";

/** Dispatch a routed query to the appropriate handler, returning structured data. */
export async function dispatchRoute(
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

export async function getCircularDeps(kvStore: KVStore, repo?: string): Promise<unknown> {
  const keys = await kvStore.keys("circularDeps:");
  const results: Array<{ repo: string; cycles: Array<{ cycle: string[]; barrelMediated: boolean }> }> = [];
  for (const key of keys) {
    const r = key.replace("circularDeps:", "");
    if (repo && r !== repo) continue;
    const json = await kvStore.get(key);
    if (!json) continue;
    try {
      const cycles = JSON.parse(json) as string[][];
      // Load barrel-mediation flags (may not exist for older indexes).
      let barrelFlags: boolean[] = [];
      const barrelJson = await kvStore.get(`circularDepsBarrel:${r}`);
      if (barrelJson) {
        try { barrelFlags = JSON.parse(barrelJson) as boolean[]; } catch { /* ignore */ }
      }
      results.push({
        repo: r,
        cycles: cycles.map((cycle, i) => ({ cycle, barrelMediated: barrelFlags[i] === true })),
      });
    } catch { /* skip corrupted */ }
  }
  const totalCycles = results.reduce((n, r) => n + r.cycles.length, 0);
  const totalBarrel = results.reduce((n, r) => n + r.cycles.filter((c) => c.barrelMediated).length, 0);
  return { totalCycles, totalBarrelMediated: totalBarrel, repos: results };
}

export async function getPatterns(kvStore: KVStore, query: string, repo?: string): Promise<unknown> {
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

export async function getDocumentation(kvStore: KVStore, repo?: string): Promise<unknown> {
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

export async function getFaultTrees(kvStore: KVStore, repo?: string): Promise<unknown> {
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

export async function getDiagnosticsForAnalytical(
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

export function resolveCategoryFilter(keywords: string[]): string | null {
  for (const kw of keywords) {
    if (/^warnings?$/.test(kw)) return "warning";
    if (/^errors?$/.test(kw)) return "error";
    if (/^notes?$/.test(kw)) return "note";
  }
  return null;
}

export function resolveCategoryRuleFilter(keywords: string[]): string | null {
  for (const kw of keywords) {
    if (/^(?:faults?|unhandled|gaps?|missing)$/.test(kw)) return "fault/";
    if (/^(?:configs?|flags?|interactions?|untested)$/.test(kw)) return "config/";
  }
  return null;
}

export async function getMetrics(kvStore: KVStore, moduleFilter?: string, repo?: string): Promise<unknown> {
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

export async function computeBlastRadiusFromDispatch(
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
