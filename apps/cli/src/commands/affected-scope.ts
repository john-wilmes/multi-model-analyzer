/**
 * Git-affected scoping: combine git diff changeset with blast radius
 * to determine which files need re-analysis.
 */

import type { ChangeSet } from "@mma/core";
import type { GraphStore } from "@mma/storage";
import { computeBlastRadius } from "@mma/query";

export interface AffectedScope {
  readonly changedFiles: string[];
  readonly affectedFiles: string[];
  readonly allScopedFiles: string[];
  readonly repo: string;
}

/** Compute affected scope per repo. Expects one ChangeSet per repo. */
export async function computeAffectedScope(
  changeSets: readonly ChangeSet[],
  graphStore: GraphStore,
  options?: { maxBlastDepth?: number },
): Promise<Map<string, AffectedScope>> {
  const maxDepth = options?.maxBlastDepth ?? 5;
  const result = new Map<string, AffectedScope>();

  for (const cs of changeSets) {
    const changedFiles = [
      ...cs.addedFiles,
      ...cs.modifiedFiles,
    ];
    // Include deleted files as blast radius roots: dependents of deleted files
    // need re-analysis even though deleted files won't be parsed themselves.
    const blastRoots = [...changedFiles, ...cs.deletedFiles];

    if (blastRoots.length === 0) {
      result.set(cs.repo, {
        changedFiles: [],
        affectedFiles: [],
        allScopedFiles: [],
        repo: cs.repo,
      });
      continue;
    }

    const blastResult = await computeBlastRadius(
      blastRoots,
      graphStore,
      { maxDepth, repo: cs.repo },
    );

    const affectedPaths = blastResult.affectedFiles.map((f) => f.path);
    // allScopedFiles only includes files that still exist (not deleted),
    // since deleted files can't be parsed.
    const allScoped = [...new Set([...changedFiles, ...affectedPaths])];

    result.set(cs.repo, {
      changedFiles,
      affectedFiles: affectedPaths,
      allScopedFiles: allScoped,
      repo: cs.repo,
    });
  }

  return result;
}
