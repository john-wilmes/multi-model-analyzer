/**
 * `mma index-org` — Scan a GitHub org, clone all repos, index in batches.
 *
 * Designed for 300-repo scale with resumability, OOM resilience, and
 * progress reporting.
 */

import pLimit from "p-limit";
import type { RepoConfig } from "@mma/core";
import type { KVStore, GraphStore, SearchStore } from "@mma/storage";
import { scanGitHubOrg, cloneOrFetch } from "@mma/ingestion";
import type { DiscoveredRepo } from "@mma/ingestion";
import { RepoStateManager } from "@mma/correlation";
import { indexCommand } from "./index-cmd.js";

export interface IndexOrgOptions {
  readonly org: string;
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly mirrorDir: string;
  readonly concurrency: number;
  readonly languages: string[];
  readonly force: boolean;
  readonly verbose: boolean;
  readonly batchSize: number;
  readonly excludeForks?: boolean;
  readonly excludeArchived?: boolean;
  readonly enrich?: boolean;
  readonly ollamaUrl?: string;
  readonly ollamaModel?: string;
  readonly llmProvider?: "anthropic" | "openai" | "ollama";
  readonly llmApiKey?: string;
  readonly llmModel?: string;
}

export interface IndexOrgResult {
  readonly org: string;
  readonly totalDiscovered: number;
  readonly totalIndexed: number;
  readonly totalSkipped: number;
  readonly totalFailed: number;
  readonly failedRepos: string[];
  readonly duration: number; // ms
}

/**
 * Sanitise a repo full_name (e.g. "myorg/my-repo") for use as a filesystem
 * path component by replacing "/" with "--".
 */
function toMirrorSlug(fullName: string): string {
  return fullName.replace(/\//g, "--");
}

export async function indexOrgCommand(options: IndexOrgOptions): Promise<IndexOrgResult> {
  const {
    org, kvStore, graphStore, searchStore, mirrorDir, verbose,
    concurrency, languages, force, batchSize,
    excludeForks, excludeArchived,
    enrich, ollamaUrl, ollamaModel,
    llmProvider, llmApiKey, llmModel,
  } = options;

  // Validate numeric options
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer >= 1 (got ${concurrency})`);
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`--batch-size must be a positive integer >= 1 (got ${batchSize})`);
  }

  const start = Date.now();
  const log = verbose ? console.log.bind(console) : () => {};
  const stateManager = new RepoStateManager(kvStore);

  // ── Phase 1: Scan org ──────────────────────────────────────────────────────
  console.log(`Scanning GitHub org "${org}"...`);
  const scanResult = await scanGitHubOrg({
    org,
    languages,
    excludeForks: excludeForks ?? true,
    excludeArchived: excludeArchived ?? true,
  });

  await kvStore.set(`org-scan:${org}`, JSON.stringify(scanResult));

  console.log(
    `Found ${scanResult.repos.length} repos (${scanResult.totalReposInOrg} total in org, ` +
    `filtered to ${languages.join(",")})`,
  );

  if (scanResult.repos.length === 0) {
    return { org, totalDiscovered: 0, totalIndexed: 0, totalSkipped: 0, totalFailed: 0, failedRepos: [], duration: Date.now() - start };
  }

  // ── Phase 2: Register candidates ───────────────────────────────────────────
  // addCandidate is idempotent: returns existing state without throwing if already registered.
  // Use fullName (e.g. "myorg/my-repo") as the stable key to avoid collisions across orgs.
  for (const repo of scanResult.repos) {
    await stateManager.addCandidate({ name: repo.fullName, url: repo.url }, "org-scan");
  }

  // ── Phase 3: Determine which repos to index ────────────────────────────────
  const allStatesList = await stateManager.getAll();
  const allStates = new Map(allStatesList.map(s => [s.name, s]));
  let ignoredCount = 0;
  for (const [name, state] of allStates) {
    if (state.status === "indexing") {
      log(`  Resetting stuck repo "${name}" from indexing → candidate`);
      await stateManager.forceCandidate(name);
    }
    if (state.status === "ignored") ignoredCount++;
  }

  const reposToIndex: DiscoveredRepo[] = [];
  const skipped: string[] = [];
  for (const repo of scanResult.repos) {
    const state = allStates.get(repo.fullName);
    if (!state) {
      reposToIndex.push(repo);
    } else if (state.status === "ignored") {
      skipped.push(repo.fullName);
    } else if (state.status === "indexed" && !force) {
      skipped.push(repo.fullName);
    } else {
      if (state.status === "indexed" && force) {
        await stateManager.forceCandidate(repo.fullName);
      }
      reposToIndex.push(repo);
    }
  }

  console.log(
    `Repos to index: ${reposToIndex.length} | Skipped: ${skipped.length} ` +
    `(${ignoredCount} ignored, ${skipped.length - ignoredCount} already indexed)`,
  );

  if (reposToIndex.length === 0) {
    return { org, totalDiscovered: scanResult.repos.length, totalIndexed: 0, totalSkipped: skipped.length, totalFailed: 0, failedRepos: [], duration: Date.now() - start };
  }

  // ── Phase 4: Clone repos ───────────────────────────────────────────────────
  console.log(`Cloning ${reposToIndex.length} repos (concurrency: ${concurrency})...`);
  const limit = pLimit(concurrency);
  const cloned: { repo: DiscoveredRepo; localPath: string }[] = [];
  const failedClone: string[] = [];

  await Promise.all(
    reposToIndex.map((repo, i) =>
      limit(async () => {
        const label = `[${i + 1}/${reposToIndex.length}] ${repo.fullName}`;
        try {
          log(`  Cloning ${label}...`);
          // Use sanitised fullName as the filesystem directory name to avoid
          // collisions when the same repo name appears in multiple orgs.
          const localPath = await cloneOrFetch(repo.url, toMirrorSlug(repo.fullName), {
            mirrorDir,
            branch: repo.defaultBranch,
          });
          cloned.push({ repo, localPath });
        } catch (err) {
          console.error(`  Failed to clone ${label}: ${(err as Error).message}`);
          await kvStore.set(`repo-error:${repo.fullName}`, JSON.stringify({
            error: (err as Error).message,
            phase: "clone",
            timestamp: new Date().toISOString(),
          }));
          failedClone.push(repo.fullName);
        }
      }),
    ),
  );

  console.log(`Cloned: ${cloned.length} | Clone failures: ${failedClone.length}`);

  if (cloned.length === 0) {
    return { org, totalDiscovered: scanResult.repos.length, totalIndexed: 0, totalSkipped: skipped.length, totalFailed: failedClone.length, failedRepos: failedClone, duration: Date.now() - start };
  }

  // ── Phase 5: Batch indexing ────────────────────────────────────────────────
  const batches: { repo: DiscoveredRepo; localPath: string }[][] = [];
  for (let i = 0; i < cloned.length; i += batchSize) {
    batches.push(cloned.slice(i, i + batchSize));
  }

  let totalIndexed = 0;
  const failedIndex: string[] = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!;
    const rangeStart = b * batchSize + 1;
    const rangeEnd = b * batchSize + batch.length;
    const batchLabel = `Batch ${b + 1}/${batches.length} (repos ${rangeStart}-${rangeEnd} of ${cloned.length})`;
    console.log(`\n${batchLabel}`);

    for (const { repo } of batch) {
      try {
        await stateManager.startIndexing(repo.fullName);
      } catch {
        // May already be in indexing state
      }
    }

    // RepoConfig.name must be the short repo name (used as identifier inside indexCommand).
    const repoConfigs: RepoConfig[] = batch.map(({ repo, localPath }) => ({
      name: repo.name,
      url: repo.url,
      branch: repo.defaultBranch,
      localPath,
    }));

    try {
      const result = await indexCommand({
        repos: repoConfigs,
        mirrorDir,
        kvStore,
        graphStore,
        searchStore,
        verbose,
        enrich,
        ollamaUrl,
        ollamaModel,
        llmProvider,
        llmApiKey,
        llmModel,
      });

      // Only mark repos that actually succeeded as indexed; retry failed ones next run.
      for (const { repo } of batch) {
        if (result.failedRepoNames.has(repo.name)) {
          // Reset to candidate so the next resume attempt will retry this repo.
          await stateManager.forceCandidate(repo.fullName);
          await kvStore.set(`repo-error:${repo.fullName}`, JSON.stringify({
            error: "failed during indexing pipeline",
            phase: "index",
            timestamp: new Date().toISOString(),
          }));
          failedIndex.push(repo.fullName);
        } else {
          try {
            await stateManager.markIndexed(repo.fullName);
          } catch {
            // best-effort
          }
        }
      }

      const succeededInBatch = batch.length - result.failedRepos;
      totalIndexed += succeededInBatch;
      if (result.failedRepos > 0) {
        console.warn(`  ${result.failedRepos} repo(s) failed in this batch`);
      }
      log(`  ${batchLabel}: ${result.totalFiles} files, ${result.totalSarifResults} findings`);
    } catch (err) {
      console.error(`  ${batchLabel} FAILED: ${(err as Error).message}`);
      for (const { repo } of batch) {
        await stateManager.forceCandidate(repo.fullName);
        await kvStore.set(`repo-error:${repo.fullName}`, JSON.stringify({
          error: (err as Error).message,
          phase: "index",
          timestamp: new Date().toISOString(),
        }));
        failedIndex.push(repo.fullName);
      }
    }

    // Hint GC between batches
    if (typeof globalThis.gc === "function") globalThis.gc();
  }

  // ── Phase 6: Final cross-repo correlation ──────────────────────────────────
  if (batches.length > 1 && totalIndexed > 1) {
    console.log("\nRunning final cross-repo correlation across all repos...");
    const allConfigs: RepoConfig[] = cloned
      .filter(({ repo }) => !failedIndex.includes(repo.fullName))
      .map(({ repo, localPath }) => ({
        name: repo.name,
        url: repo.url,
        branch: repo.defaultBranch,
        localPath,
      }));

    try {
      await indexCommand({
        repos: allConfigs,
        mirrorDir,
        kvStore,
        graphStore,
        searchStore,
        verbose: false,
        enrich,
        ollamaUrl,
        ollamaModel,
        llmProvider,
        llmApiKey,
        llmModel,
      });
    } catch (err) {
      console.error(`  Cross-repo correlation failed: ${(err as Error).message}`);
    }
  }

  const allFailed = [...failedClone, ...failedIndex];
  const duration = Date.now() - start;
  console.log(
    `\nDone in ${(duration / 1000).toFixed(0)}s: ${totalIndexed}/${scanResult.repos.length} indexed, ` +
    `${allFailed.length} failed, ${skipped.length} skipped`,
  );

  return {
    org,
    totalDiscovered: scanResult.repos.length,
    totalIndexed,
    totalSkipped: skipped.length,
    totalFailed: allFailed.length,
    failedRepos: allFailed,
    duration,
  };
}
