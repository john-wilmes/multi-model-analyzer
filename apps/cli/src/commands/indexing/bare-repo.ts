/**
 * Helpers for detecting and reading from bare git repositories.
 */

import { isBareRepo, getHeadCommit } from "@mma/ingestion";
import type { ChangeSet } from "@mma/core";

const bareRepoCache = new Map<string, boolean>();

export async function checkBareRepo(repoPath: string): Promise<boolean> {
  let cached = bareRepoCache.get(repoPath);
  if (cached === undefined) {
    cached = await isBareRepo(repoPath);
    bareRepoCache.set(repoPath, cached);
  }
  return cached;
}

/** Resolve a commit hash for reading files from a bare repo. */
export async function resolveCommitForBare(
  repoPath: string,
  changeSets: readonly ChangeSet[],
  repoName: string,
): Promise<string> {
  const cs = changeSets.find(c => c.repo === repoName);
  if (cs) return cs.commitHash;
  return getHeadCommit(repoPath);
}
