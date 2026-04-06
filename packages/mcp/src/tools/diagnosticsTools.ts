import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSarifResultsPaginated } from "@mma/storage";
import type { CrossRepoGraph } from "@mma/correlation";
import { computeBlastRadius, computePageRank } from "@mma/query";
import { z } from "zod";
import { jsonResult, paginated, deserializeGraph } from "./helpers.js";
import type { Stores } from "./helpers.js";

export function registerDiagnosticsTools(server: McpServer, stores: Stores): void {
  const { graphStore, searchStore, kvStore } = stores;

  // 7. SARIF diagnostics
  server.registerTool("get_diagnostics", {
    description: "Retrieve SARIF diagnostic findings from the analysis index. Filter by repository, severity level, or keyword search. Filter with level:'error' first, then get_blast_radius on affected files. For all findings, read mma://repo/{name}/findings.",
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
    const diagHints: string[] = ["Call get_blast_radius on files in top findings to assess change scope."];
    if (page.hasMore) {
      diagHints.unshift(`Showing ${page.returned} of ${page.total} results. Use offset:${(offset ?? 0) + page.returned} to fetch the next page.`);
    }
    return jsonResult(page, links, page.results.length > 0 ? diagHints : undefined);
  });

  // 9. Blast radius analysis
  server.registerTool("get_blast_radius", {
    description: "Compute the blast radius of changing one or more files: what other files would be affected via import and call dependencies. Set crossRepo:true when the repo has downstream consumers — check get_cross_repo_graph first.",
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
    const blastHints: string[] = [];
    if ((result.totalAffected ?? 0) > 10) {
      blastHints.push("High blast radius. Call get_diagnostics on changed files to check for existing issues.");
    }
    if (!crossRepo) {
      blastHints.push("Set crossRepo:true to check downstream repo impact.");
    }
    return jsonResult(sorted, undefined, blastHints.length > 0 ? blastHints : undefined);
  });

  // Vulnerability reachability findings
  server.registerTool("get_vulnerability", {
    description: "List vulnerability reachability findings from the latest analysis. Shows which vulnerable dependencies are actually imported in the codebase. Follow with get_blast_radius on vulnerable package import sites to see reachability scope.",
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
    const vulnHints = paginatedResults.length > 0
      ? ["Call get_blast_radius on files importing vulnerable packages to see reachability."]
      : undefined;
    return jsonResult({ findings: paginatedResults, total: filtered.length, offset: skip, limit: maxResults }, undefined, vulnHints);
  });
}
