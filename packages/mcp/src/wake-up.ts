import type { KVStore } from "@mma/storage";

export interface OrgDiffResult {
  org: string;
  previousRepoCount: number;
  currentRepoCount: number;
  newRepos: Array<{ name: string; language: string | null; stars: number }>;
}

export interface WakeUpResult {
  orgsChecked: number;
  totalNewRepos: number;
  results: OrgDiffResult[];
}

/**
 * Diff a single GitHub org scan against known state, registering new repos as candidates.
 */
export async function diffOrgScan(org: string, kvStore: KVStore): Promise<OrgDiffResult> {
  const { scanGitHubOrg } = await import("@mma/ingestion");
  const { RepoStateManager } = await import("@mma/correlation");

  const stateManager = new RepoStateManager(kvStore);

  // Get previous scan
  const prevScanJson = await kvStore.get(`org-scan:${org}`);
  const prevNames = new Set<string>();
  if (prevScanJson) {
    const prev = JSON.parse(prevScanJson) as { repos: Array<{ name: string }> };
    for (const r of prev.repos) {
      prevNames.add(r.name);
    }
  }

  // Re-scan
  const result = await scanGitHubOrg({ org });
  await kvStore.set(`org-scan:${org}`, JSON.stringify(result));

  // Find new repos
  const newRepos = result.repos.filter(r => !prevNames.has(r.name));

  // Register new ones as candidates
  for (const repo of newRepos) {
    const existing = await stateManager.get(repo.name);
    if (!existing) {
      await stateManager.addCandidate(
        { name: repo.name, url: repo.url, defaultBranch: repo.defaultBranch, language: repo.language ?? undefined },
        "org-scan",
      );
    }
  }

  return {
    org,
    previousRepoCount: prevNames.size,
    currentRepoCount: result.repos.length,
    newRepos: newRepos.map(r => ({
      name: r.name,
      language: r.language,
      stars: r.starCount,
    })),
  };
}

/**
 * Run wake-up check: re-scan all previously scanned orgs and diff against known state.
 * Designed to run at MCP server startup as a fire-and-forget background task.
 */
export async function runWakeUpCheck(kvStore: KVStore): Promise<WakeUpResult> {
  const orgKeys = await kvStore.keys("org-scan:");
  const orgs = orgKeys.map(k => k.slice("org-scan:".length));

  if (orgs.length === 0) {
    return { orgsChecked: 0, totalNewRepos: 0, results: [] };
  }

  const results: OrgDiffResult[] = [];
  for (const org of orgs) {
    try {
      const result = await diffOrgScan(org, kvStore);
      results.push(result);
    } catch (err) {
      console.error(`[wake-up] Failed to scan org "${org}":`, err instanceof Error ? err.message : err);
    }
  }

  const totalNewRepos = results.reduce((sum, r) => sum + r.newRepos.length, 0);
  return { orgsChecked: orgs.length, totalNewRepos, results };
}
