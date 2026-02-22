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

    if (changedFiles.length === 0) {
      result.set(cs.repo, {
        changedFiles: [],
        affectedFiles: [],
        allScopedFiles: [],
        repo: cs.repo,
      });
      continue;
    }

    const blastResult = await computeBlastRadius(
      changedFiles,
      graphStore,
      { maxDepth, repo: cs.repo },
    );

    const affectedPaths = blastResult.affectedFiles.map((f) => f.path);
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
