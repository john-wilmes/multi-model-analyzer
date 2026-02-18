/**
 * CLI command: index repos.
 *
 * Runs the full indexing pipeline: ingestion -> parsing -> structural ->
 * heuristics -> summarization -> storage.
 */

import type { RepoConfig, ChangeSet } from "@mma/core";
import { detectChanges, classifyFiles } from "@mma/ingestion";
import type { KVStore } from "@mma/storage";

export interface IndexOptions {
  readonly repos: readonly RepoConfig[];
  readonly mirrorDir: string;
  readonly kvStore: KVStore;
  readonly verbose: boolean;
}

export async function indexCommand(options: IndexOptions): Promise<void> {
  const { repos, mirrorDir, kvStore, verbose } = options;

  const log = verbose ? console.log : () => {};

  log(`Indexing ${repos.length} repositories...`);

  // Load previous commit hashes
  const previousCommits = new Map<string, string>();
  for (const repo of repos) {
    const prev = await kvStore.get(`commit:${repo.name}`);
    if (prev) previousCommits.set(repo.name, prev);
  }

  // Phase 1: Ingestion
  log("Phase 1: Detecting changes...");
  const changeSets: ChangeSet[] = [];
  for (const repo of repos) {
    try {
      const changeSet = await detectChanges(repo, {
        mirrorDir,
        previousCommits,
      });
      changeSets.push(changeSet);
      log(`  ${repo.name}: ${changeSet.addedFiles.length} added, ${changeSet.modifiedFiles.length} modified, ${changeSet.deletedFiles.length} deleted`);
    } catch (error) {
      console.error(`  Failed to index ${repo.name}:`, error);
    }
  }

  // Phase 2: Classify files
  log("Phase 2: Classifying files...");
  for (const changeSet of changeSets) {
    const classified = classifyFiles(changeSet);
    log(`  ${changeSet.repo}: ${classified.length} files classified`);
  }

  // Phase 3-7 would follow: parsing, structural, heuristics, summarization, models
  // These are stubbed -- full implementation requires runtime dependencies
  log("Phase 3-7: Analysis pipeline (stubbed for initial scaffold)");

  // Save commit hashes
  for (const changeSet of changeSets) {
    await kvStore.set(`commit:${changeSet.repo}`, changeSet.commitHash);
  }

  log("Indexing complete.");
}
