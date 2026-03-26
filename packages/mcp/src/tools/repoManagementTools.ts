import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonResult } from "./helpers.js";
import type { Stores } from "./helpers.js";

export function registerRepoManagementTools(server: McpServer, stores: Stores): void {
  const { kvStore, mirrorDir, indexRepo } = stores;

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
    const { diffOrgScan } = await import("../wake-up.js");
    const result = await diffOrgScan(org, kvStore);
    return jsonResult(result);
  });
}
