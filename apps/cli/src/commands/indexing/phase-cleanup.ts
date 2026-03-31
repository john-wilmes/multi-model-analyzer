/**
 * Phase 0: Remove stale data for deleted and modified files.
 * @see ./phase-cleanup.test.ts
 */

import type { ChangeSet } from "@mma/core";
import type { KVStore, GraphStore, SearchStore } from "@mma/storage";

export interface PhaseCleanupInput {
  readonly changeSets: readonly ChangeSet[];
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly log: (...args: unknown[]) => void;
}

export async function runPhaseCleanup(input: PhaseCleanupInput): Promise<void> {
  const { changeSets, kvStore, graphStore, searchStore, log } = input;

  await Promise.all(changeSets.map(async (changeSet) => {
    if (changeSet.deletedFiles.length > 0) {
      log(`Phase 0: Cleaning up ${changeSet.deletedFiles.length} deleted files from ${changeSet.repo}...`);

      // Remove from search index
      await searchStore.deleteByFilePaths(changeSet.repo, changeSet.deletedFiles);

      // Remove stale graph edges sourced from deleted files
      await graphStore.deleteEdgesForFiles(changeSet.repo, changeSet.deletedFiles);

      // Remove KV entries associated with deleted files
      await Promise.all(changeSet.deletedFiles.flatMap(filePath => [
        kvStore.deleteByPrefix(`symbols:${changeSet.repo}:${filePath}`),
        kvStore.deleteByPrefix(`summary:t1:${changeSet.repo}:${filePath}:`),
        kvStore.deleteByPrefix(`summary:t3:${changeSet.repo}:${filePath}#`),
      ]));

      // Remove stale SARIF findings for deleted files.
      // When a run has only deletions, Phase 3+ is skipped (classified.length === 0),
      // so the per-type SARIF keys are never regenerated. Filter deleted paths out
      // of each key now so they don't persist into the aggregated sarif:latest.
      const deletedSet = new Set(changeSet.deletedFiles);
      const sarifTypeKeys = ["config", "fault", "deadExports", "arch", "instability", "blastRadius", "hotspot", "temporal-coupling", "vuln"] as const;
      await Promise.all(sarifTypeKeys.map(async (typeKey) => {
        const kvKey = `sarif:${typeKey}:${changeSet.repo}`;
        const json = await kvStore.get(kvKey);
        if (!json) return;
        let results: import("@mma/core").SarifResult[];
        try {
          results = JSON.parse(json) as import("@mma/core").SarifResult[];
        } catch {
          return; // malformed; leave intact
        }
        const filtered = results.filter((r) => {
          const primaryUri =
            r.locations?.[0]?.physicalLocation?.artifactLocation?.uri ??
            r.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName;
          return !primaryUri || !deletedSet.has(primaryUri);
        });
        if (filtered.length !== results.length) {
          await kvStore.set(kvKey, JSON.stringify(filtered));
        }
      }));

      log(`  Removed stale data for ${changeSet.deletedFiles.length} files`);
    }

    // Invalidate Tier 3 (LLM) summaries for modified files so they get
    // regenerated on the next enrich run. T3 keys are entity-addressed
    // (no contentHash), so without this they persist with stale descriptions.
    // Tier 1 handles its own invalidation via contentHash-keyed entries.
    if (changeSet.modifiedFiles.length > 0) {
      const t3Deletes = changeSet.modifiedFiles.map(filePath =>
        kvStore.deleteByPrefix(`summary:t3:${changeSet.repo}:${filePath}#`),
      );
      await Promise.all(t3Deletes);
      if (t3Deletes.length > 0) {
        log(`Phase 0: Invalidated T3 summaries for ${changeSet.modifiedFiles.length} modified files in ${changeSet.repo}`);
      }
    }
  }));
}
