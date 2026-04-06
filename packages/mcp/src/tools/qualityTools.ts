import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonResult, paginated } from "./helpers.js";
import type { Stores } from "./helpers.js";

export function registerQualityTools(server: McpServer, stores: Stores): void {
  const { kvStore } = stores;

  // 21. Hotspot analysis (high-churn × high-complexity files)
  server.registerTool("get_hotspots", {
    description: "Get hotspot files ranked by churn × complexity score. Hotspots are the riskiest files to change — high change frequency combined with high complexity. Useful for prioritizing refactoring and code review. Follow with get_blast_radius on top files to understand change risk, and get_diagnostics for existing issues.",
    inputSchema: {
      repo: z.string().optional().describe("Filter to a specific repository name"),
      limit: z.number().optional().describe("Max results to return (default 20)"),
      offset: z.number().optional().describe("Number of results to skip for pagination (default 0)"),
    },
  }, async ({ repo, limit, offset }) => {
    const maxResults = limit ?? 20;
    const skip = offset ?? 0;
    const keys = await kvStore.keys("hotspots:");
    const result: Array<Record<string, unknown>> = [];

    for (const key of keys) {
      const keyRepo = key.slice("hotspots:".length);
      if (repo && keyRepo !== repo) continue;
      const json = await kvStore.get(key);
      if (json) {
        try {
          const hotspots = JSON.parse(json) as Array<Record<string, unknown>>;
          for (const h of hotspots) {
            result.push({ ...h, repo: keyRepo });
          }
        } catch { /* skip malformed */ }
      }
    }

    if (result.length === 0) {
      return jsonResult({
        results: [], total: 0, offset: skip, limit: maxResults,
        note: repo
          ? `No hotspot data for "${repo}". Run 'mma index' first.`
          : "No hotspot data available. Run 'mma index' first.",
      });
    }

    // Re-normalize scores globally across all repos so the cross-repo ranking
    // is meaningful (per-repo scores are each independently normalized to 100).
    let maxChurn = 0;
    let maxSymbols = 0;
    for (const h of result) {
      const c = h["churn"] as number ?? 0;
      const s = h["symbolCount"] as number ?? 0;
      if (c > maxChurn) maxChurn = c;
      if (s > maxSymbols) maxSymbols = s;
    }
    const normalized = result.map((h) => {
      const churnScore = maxChurn > 0 ? ((h["churn"] as number ?? 0) / maxChurn) * 100 : 0;
      const complexityScore = maxSymbols > 0 ? ((h["symbolCount"] as number ?? 0) / maxSymbols) * 100 : 0;
      return { ...h, hotspotScore: Math.round((churnScore + complexityScore) / 2) };
    });
    normalized.sort((a, b) => (b.hotspotScore) - (a.hotspotScore));
    const paginatedResult = paginated(normalized, skip, maxResults);
    const hotspotHints: string[] = [];
    if (paginatedResult.results.length > 0) {
      hotspotHints.push("Call get_blast_radius on the top-scored files to assess change risk.");
      hotspotHints.push("Call get_diagnostics filtered by repo for existing issues in hotspot files.");
    }
    return jsonResult(paginatedResult, undefined, hotspotHints.length > 0 ? hotspotHints : undefined);
  });

  // 22. Temporal coupling (files that change together without declared dependency)
  server.registerTool("get_temporal_coupling", {
    description: "Get temporally coupled file pairs — files that frequently change together in commits but may have no declared import dependency. Reveals hidden logical coupling and architectural drift. Pairs without a declared import edge represent hidden coupling — validate with get_dependencies.",
    inputSchema: {
      repo: z.string().optional().describe("Filter to a specific repository name"),
      minCoChanges: z.number().optional().describe("Minimum co-change count to include (default 2)"),
      limit: z.number().optional().describe("Max results to return (default 30)"),
      offset: z.number().optional().describe("Number of results to skip for pagination (default 0)"),
    },
  }, async ({ repo, minCoChanges, limit, offset }) => {
    const maxResults = limit ?? 30;
    const skip = offset ?? 0;
    const minCount = minCoChanges ?? 2;

    if (repo) {
      const json = await kvStore.get(`temporal-coupling:${repo}`);
      if (!json) {
        return jsonResult({
          ...paginated([], skip, maxResults),
          commitsAnalyzed: 0,
          note: `No temporal coupling data for "${repo}". Temporal coupling requires git history (not available for single-commit bare clones).`,
        });
      }
      try {
        const data = JSON.parse(json) as { pairs: Array<Record<string, unknown>>; commitsAnalyzed?: number; commitsSkipped?: number };
        const filtered = (data.pairs ?? []).filter((p) => (p["coChangeCount"] as number) >= minCount);
        filtered.sort((a, b) => (b["coChangeCount"] as number) - (a["coChangeCount"] as number));
        const tcPaged = paginated(filtered, skip, maxResults);
        const tcHints: string[] = [];
        if (tcPaged.results.length > 0) {
          tcHints.push("Validate hidden coupling by calling get_dependencies on paired files.");
        }
        return jsonResult({
          ...tcPaged,
          commitsAnalyzed: data.commitsAnalyzed ?? 0,
          commitsSkipped: data.commitsSkipped ?? 0,
        }, undefined, tcHints.length > 0 ? tcHints : undefined);
      } catch {
        return jsonResult({ pairs: [], total: 0, error: "Could not parse temporal coupling data" });
      }
    }

    // All repos
    const keys = await kvStore.keys("temporal-coupling:");
    const allPairs: Array<Record<string, unknown>> = [];
    for (const key of keys) {
      const keyRepo = key.slice("temporal-coupling:".length);
      const json = await kvStore.get(key);
      if (json) {
        try {
          const data = JSON.parse(json) as { pairs: Array<Record<string, unknown>> };
          for (const p of data.pairs ?? []) {
            if ((p["coChangeCount"] as number) >= minCount) {
              allPairs.push({ ...p, repo: keyRepo });
            }
          }
        } catch { /* skip malformed */ }
      }
    }

    allPairs.sort((a, b) => (b["coChangeCount"] as number) - (a["coChangeCount"] as number));
    const allTcPaged = paginated(allPairs, skip, maxResults);
    const allTcHints: string[] = [];
    if (allTcPaged.results.length > 0) {
      allTcHints.push("Validate hidden coupling by calling get_dependencies on paired files.");
    }
    return jsonResult(allTcPaged, undefined, allTcHints.length > 0 ? allTcHints : undefined);
  });
}
