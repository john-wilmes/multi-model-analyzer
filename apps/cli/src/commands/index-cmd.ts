/**
 * CLI command: index repos.
 *
 * Runs the full indexing pipeline: ingestion -> parsing -> structural ->
 * heuristics -> summarization -> storage.
 */

import type { RepoConfig, ChangeSet } from "@mma/core";
import { detectChanges, classifyFiles } from "@mma/ingestion";
import { parseFiles } from "@mma/parsing";
import type { KVStore } from "@mma/storage";

export interface IndexOptions {
  readonly repos: readonly RepoConfig[];
  readonly mirrorDir: string;
  readonly kvStore: KVStore;
  readonly verbose: boolean;
  readonly enableTsMorph?: boolean;
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
  const classifiedByRepo = new Map<string, ReturnType<typeof classifyFiles>>();
  for (const changeSet of changeSets) {
    const classified = classifyFiles(changeSet);
    classifiedByRepo.set(changeSet.repo, classified);
    log(`  ${changeSet.repo}: ${classified.length} files classified`);
  }

  // Phase 3: Parsing
  log("Phase 3: Parsing files...");
  for (const repo of repos) {
    const classified = classifiedByRepo.get(repo.name);
    if (!classified || classified.length === 0) continue;

    try {
      const result = await parseFiles(classified, repo.name, repo.localPath, {
        enableTsMorph: options.enableTsMorph,
        onProgress: verbose
          ? (info) => {
              if (info.current === 1 || info.current % 100 === 0 || info.current === info.total) {
                log(`  [${info.phase}] ${info.current}/${info.total}`);
              }
            }
          : undefined,
      });

      log(`  ${repo.name}: ${result.stats.fileCount} files, ${result.stats.symbolCount} symbols, ${result.stats.errorCount} errors`);
      log(`    tree-sitter: ${result.stats.treeSitterTimeMs}ms, ts-morph: ${result.stats.tsMorphTimeMs}ms`);

      // Store tree-sitter trees for Phase 4 (structural analysis)
      // TODO: Pass treeSitterTrees to structural analysis when implemented
    } catch (error) {
      console.error(`  Failed to parse ${repo.name}:`, error);
    }
  }

  // Phase 4-7: structural, heuristics, summarization, models (still stubbed)
  log("Phase 4-7: Analysis pipeline (stubbed for initial scaffold)");

  // Save commit hashes
  for (const changeSet of changeSets) {
    await kvStore.set(`commit:${changeSet.repo}`, changeSet.commitHash);
  }

  log("Indexing complete.");
}
