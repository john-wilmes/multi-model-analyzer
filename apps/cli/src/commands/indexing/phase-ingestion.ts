/**
 * Phase 1: Change detection across all repos.
 */

import type { RepoConfig, ChangeSet } from "@mma/core";
import type { KVStore } from "@mma/storage";
import { detectChanges } from "@mma/ingestion";
import { pLimit } from "./pLimit.js";

export interface PhaseIngestionInput {
  readonly repos: readonly RepoConfig[];
  readonly mirrorDir: string;
  readonly kvStore: KVStore;
  readonly verbose: boolean;
  readonly log: (...args: unknown[]) => void;
  readonly changeSets: ChangeSet[];
  readonly failedRepoNames: Set<string>;
  readonly previousCommits: Map<string, string>;
}

export async function runPhaseIngestion(input: PhaseIngestionInput): Promise<void> {
  const { repos, mirrorDir, log, changeSets, failedRepoNames, previousCommits } = input;
  const isTTY = process.stderr.isTTY;
  let ingestionDone = 0;
  const ingestionLimit = pLimit(4);

  await Promise.all(repos.map((repo, i) => ingestionLimit(async () => {
    if (!input.verbose) {
      const progress = `[${i + 1}/${repos.length}] ${repo.name}`;
      if (isTTY) {
        process.stderr.write(`\r${progress}\x1b[K`);
      } else {
        process.stderr.write(`${progress}\n`);
      }
    }
    try {
      const changeSet = await detectChanges(repo, {
        mirrorDir,
        previousCommits,
      });
      changeSets.push(changeSet);
      log(`  ${repo.name}: ${changeSet.addedFiles.length} added, ${changeSet.modifiedFiles.length} modified, ${changeSet.deletedFiles.length} deleted`);
    } catch (error) {
      console.error(`  Failed to index ${repo.name}:`, error);
      failedRepoNames.add(repo.name);
    }
    ingestionDone++;
    if (!input.verbose && isTTY) {
      process.stderr.write(`\r[${ingestionDone}/${repos.length}] done\x1b[K`);
    }
  })));

  // Clear progress line when done (TTY only)
  if (!input.verbose && isTTY && repos.length > 0) {
    process.stderr.write(`\r\x1b[K`);
  }
}
