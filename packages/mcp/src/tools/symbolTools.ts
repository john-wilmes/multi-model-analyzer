import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CrossRepoGraph, ResolvedImportedSymbol } from "@mma/correlation";
import { z } from "zod";
import { jsonResult, deserializeGraph } from "./helpers.js";
import type { Stores } from "./helpers.js";

export function registerSymbolTools(server: McpServer, stores: Stores): void {
  const { kvStore } = stores;

  // 24. Cross-repo symbol importers
  server.registerTool("get_symbol_importers", {
    description: "Find which repositories import a specific symbol from a package. Requires cross-repo correlation data with symbol resolution. Use after get_cross_repo_graph confirms multiple repos are indexed.",
    inputSchema: {
      symbol: z.string().describe("Symbol name to search for (e.g. 'createClient', 'SupabaseClient')"),
      package: z.string().optional().describe("Package name to filter by (e.g. '@supabase/supabase-js')"),
      repo: z.string().optional().describe("Filter to edges targeting this repo"),
    },
  }, async ({ symbol, package: pkg, repo }) => {
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

    const matches: Array<{
      sourceRepo: string;
      sourceFile: string;
      targetRepo: string;
      targetFile: string;
      packageName: string;
      resolvedSymbols: ResolvedImportedSymbol[];
    }> = [];

    for (const resolved of graph.edges) {
      if (pkg && resolved.packageName !== pkg) continue;
      if (repo && resolved.targetRepo !== repo) continue;

      const syms = Array.isArray(resolved.edge.metadata?.resolvedSymbols)
        ? (resolved.edge.metadata.resolvedSymbols as ResolvedImportedSymbol[])
        : [];
      const matching = syms.filter((s) => s.name === symbol);

      if (matching.length > 0) {
        matches.push({
          sourceRepo: resolved.sourceRepo,
          sourceFile: resolved.edge.source,
          targetRepo: resolved.targetRepo,
          targetFile: resolved.edge.target,
          packageName: resolved.packageName,
          resolvedSymbols: matching,
        });
        continue;
      }

      // Per-edge fallback: use importedNames when resolvedSymbols has no match.
      const names = Array.isArray(resolved.edge.metadata?.importedNames)
        ? (resolved.edge.metadata.importedNames as string[])
        : [];
      if (names.includes(symbol)) {
        matches.push({
          sourceRepo: resolved.sourceRepo,
          sourceFile: resolved.edge.source,
          targetRepo: resolved.targetRepo,
          targetFile: resolved.edge.target,
          packageName: resolved.packageName,
          resolvedSymbols: [],
        });
      }
    }

    // Group by sourceRepo to avoid duplicates when multiple edges from the same
    // repo import the same symbol.
    const byRepo = new Map<string, typeof matches>();
    for (const m of matches) {
      const list = byRepo.get(m.sourceRepo) ?? [];
      list.push(m);
      byRepo.set(m.sourceRepo, list);
    }

    const importers = [...byRepo.entries()].map(([sourceRepo, edges]) => ({
      repo: sourceRepo,
      files: edges.map((e) => ({
        sourceFile: e.sourceFile,
        targetRepo: e.targetRepo,
        targetFile: e.targetFile,
        packageName: e.packageName,
        resolvedSymbols: e.resolvedSymbols,
      })),
    }));

    const symbolHints: string[] = [];
    if (importers.length > 0) {
      symbolHints.push("Call get_callers on specific importers to trace deeper usage.");
    } else {
      symbolHints.push("No importers found — ensure 2+ repos are indexed with cross-repo correlation.");
    }
    return jsonResult({
      symbol,
      package: pkg ?? null,
      importerCount: importers.length,
      importers,
    }, undefined, symbolHints);
  });
}
