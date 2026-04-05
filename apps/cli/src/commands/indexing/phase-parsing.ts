/**
 * Phase 3: Tree-sitter / ts-morph parsing.
 */

import { join } from "node:path";
import type { RepoConfig } from "@mma/core";
import type { classifyFiles } from "@mma/ingestion";
import { parseFiles } from "@mma/parsing";
import { getFileContent } from "@mma/ingestion";
import { checkBareRepo, resolveCommitForBare } from "./bare-repo.js";
import type { PipelineContext } from "./types.js";

export async function runPhaseParsing(
  ctx: PipelineContext,
  repo: RepoConfig,
  classified: ReturnType<typeof classifyFiles>,
  sourceTextCache: Map<string, string>,
): Promise<boolean> {
  const { log, mirrorDir, kvStore, options, changeSets } = ctx;
  const repoPath = repo.localPath ?? join(mirrorDir, `${repo.name}.git`);

  log(`  [${repo.name}] Parsing files...`);
  const phase3Start = performance.now();
  try {
    // Detect bare repos (no working tree) so we can read content via git show.
    const isBare = await checkBareRepo(repoPath);
    const bareCommit = isBare ? await resolveCommitForBare(repoPath, changeSets, repo.name) : undefined;
    const contentProvider =
      isBare && bareCommit
        ? async (filePath: string) => {
            const text = await getFileContent(repoPath, bareCommit, filePath);
            sourceTextCache.set(filePath, text);
            return text;
          }
        : undefined;

    const result = await parseFiles(classified, repo.name, repoPath, {
      enableTsMorph: options.enableTsMorph,
      contentProvider,
      onProgress: options.verbose
        ? (info) => {
            if (info.current === 1 || info.current % 100 === 0 || info.current === info.total) {
              log(`    [${info.phase}] ${info.current}/${info.total}`);
            }
          }
        : undefined,
    });

    log(`  [${repo.name}] ${result.stats.fileCount} files, ${result.stats.symbolCount} symbols, ${result.stats.errorCount} errors`);
    log(`    tree-sitter: ${result.stats.treeSitterTimeMs}ms, ts-morph: ${result.stats.tsMorphTimeMs}ms`);

    if (result.parsedFiles.length === 0) {
      log(`    warning: 0 parsed files produced -- downstream phases will have no data`);
    } else if (result.stats.symbolCount === 0) {
      log(`    warning: 0 symbols extracted from ${result.parsedFiles.length} files`);
    }

    // Store trees on context for use by structural and models phases
    if (result.treeSitterTrees && result.treeSitterTrees.size > 0) {
      ctx.treesByRepo.set(repo.name, result.treeSitterTrees);
    }
    ctx.parsedFilesByRepo.set(repo.name, result.parsedFiles);

    // For incremental mode: load cached symbols for unchanged files and merge
    if (!options.forceFullReindex) {
      const changedPathSet = new Set(result.parsedFiles.map(pf => pf.path));
      const symbolEntries = await kvStore.getByPrefix(`symbols:${repo.name}:`);
      for (const [key, raw] of symbolEntries) {
        const filePath = key.slice(`symbols:${repo.name}:`.length);
        if (changedPathSet.has(filePath)) continue; // freshly parsed
        try {
          const { symbols, contentHash, kind = "typescript" } = JSON.parse(raw) as { symbols: import("@mma/core").SymbolInfo[]; contentHash: string; kind?: string };
          result.parsedFiles.push({ path: filePath, repo: repo.name, kind: kind as import("@mma/core").ParsedFile["kind"], symbols, contentHash, errors: [] });
        } catch {
          // skip malformed cached entry
        }
      }
    }

    // Persist parsed symbols to KV for failure recovery.
    // If Phase 5+ fails, the next run can load these instead of re-parsing.
    const symbolEntries: Array<readonly [string, string]> = result.parsedFiles.map((pf) => [
      `symbols:${repo.name}:${pf.path}`,
      JSON.stringify({ symbols: pf.symbols, contentHash: pf.contentHash, kind: pf.kind }),
    ] as const);
    await kvStore.setMany(symbolEntries);
    log(`  [${repo.name}] Phase 3: ${Math.round(performance.now() - phase3Start)}ms`);
    return true;
  } catch (error) {
    console.error(`  Failed to parse ${repo.name}:`, error);
    ctx.failedRepoNames.add(repo.name);
    return false;
  }
}
