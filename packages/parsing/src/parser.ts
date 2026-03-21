/**
 * Unified parsing orchestrator.
 *
 * Phase 1: tree-sitter for all parseable files (fast, syntax-only).
 * Phase 2: ts-morph (optional) for type-resolved symbol extraction.
 *
 * Graceful degradation: either engine can fail independently.
 */

import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { ClassifiedFile, ParsedFile } from "@mma/core";
import { isParseable, classifyFileKind } from "./classify.js";
import {
  initTreeSitter,
  parseSource,
  extractSymbolsFromTree,
  createParsedFile,
} from "./treesitter.js";
import type { TreeSitterTree } from "./treesitter.js";
import {
  createTsMorphProject,
  extractSymbolsFromSourceFile,
} from "./tsmorph.js";
import { hashContent } from "./treesitter.js";

/** Default file-level concurrency for the tree-sitter phase. */
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(availableParallelism(), 8));

export interface ParseOptions {
  readonly enableTsMorph?: boolean;
  readonly tsconfigPath?: string;
  readonly onProgress?: (info: ProgressInfo) => void;
  readonly contentProvider?: (filePath: string) => Promise<string>;
  /**
   * Maximum number of files to parse concurrently in the tree-sitter phase.
   * Defaults to `Math.min(os.availableParallelism(), 8)`.
   */
  readonly concurrency?: number;
}

export interface ProgressInfo {
  readonly phase: string;
  readonly current: number;
  readonly total: number;
  readonly filePath?: string;
}

export interface ParseResult {
  readonly parsedFiles: ParsedFile[];
  readonly treeSitterTrees: ReadonlyMap<string, TreeSitterTree>;
  readonly stats: ParseStats;
}

export interface ParseStats {
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly errorCount: number;
  readonly treeSitterTimeMs: number;
  readonly tsMorphTimeMs: number;
}

/**
 * Run tasks with a sliding-window concurrency pool.
 * Resolves when all tasks complete. Callers must handle errors within `fn`;
 * uncaught rejections will propagate and abort remaining work.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]!, idx);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
}

export async function parseFiles(
  files: readonly ClassifiedFile[],
  repo: string,
  rootDir: string,
  options?: ParseOptions,
): Promise<ParseResult> {
  const parseableFiles = files.filter((f) => isParseable(f.kind));
  const progress = options?.onProgress;
  const rawConcurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(rawConcurrency) || rawConcurrency < 1) {
    throw new RangeError("ParseOptions.concurrency must be a positive integer");
  }
  const concurrency = rawConcurrency;

  // Slots are pre-allocated so output order matches input order regardless of
  // which files finish first (avoids non-deterministic test failures).
  const parsedFileSlots: (ParsedFile | null)[] = new Array(parseableFiles.length).fill(null);
  const treeSitterTrees = new Map<string, TreeSitterTree>();

  let treeSitterTimeMs = 0;
  let tsMorphTimeMs = 0;

  // Phase 1: tree-sitter (fast, syntax-only)
  let tsInitOk = true;
  try {
    await initTreeSitter();
  } catch (err) {
    console.warn("tree-sitter init failed, falling back to ts-morph only:", err);
    tsInitOk = false;
  }

  if (tsInitOk) {
    const start = performance.now();
    let notFoundCount = 0;
    // Shared counter for progress reporting; incremented after each file is
    // parsed so "current" reflects completed (not just started) files.
    let progressCounter = 0;

    await runWithConcurrency(parseableFiles, concurrency, async (file, idx) => {
      try {
        const content = options?.contentProvider
          ? await options.contentProvider(file.path)
          : await readFile(join(rootDir, file.path), "utf-8");
        const tree = parseSource(content, file.path);
        treeSitterTrees.set(file.path, tree);

        const { symbols, errors } = extractSymbolsFromTree(tree, file.path, repo);
        const kind = classifyFileKind(file.path);
        parsedFileSlots[idx] = createParsedFile(file.path, repo, content, kind, symbols, errors);
      } catch (err) {
        if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT") {
          notFoundCount++;
        } else {
          console.warn(`tree-sitter parse failed for ${file.path}:`, err);
        }
      } finally {
        const current = ++progressCounter;
        progress?.({ phase: "tree-sitter", current, total: parseableFiles.length, filePath: file.path });
      }
    });

    if (notFoundCount > 0) {
      console.warn(`tree-sitter: skipped ${notFoundCount} files (not found on disk)`);
    }
    treeSitterTimeMs = performance.now() - start;
  }

  // Collapse slots to a dense array, preserving input order.
  const parsedFiles: ParsedFile[] = parsedFileSlots.filter((p): p is ParsedFile => p !== null);

  // Phase 2: ts-morph (optional, type-resolved)
  // ts-morph requires filesystem access; skip for bare repos (contentProvider signals bare repo)
  if (options?.enableTsMorph && !options?.contentProvider) {
    const start = performance.now();
    try {
      const project = createTsMorphProject({
        tsconfigPath: options.tsconfigPath,
      });

      const tsFiles = parseableFiles.filter(
        (f) => f.kind === "typescript",
      );

      const absPaths = tsFiles.map((f) => join(rootDir, f.path));
      project.addSourceFilesAtPaths(absPaths);

      const sourceFiles = project.getSourceFiles();
      for (let i = 0; i < sourceFiles.length; i++) {
        const sf = sourceFiles[i]!;
        progress?.({ phase: "ts-morph", current: i + 1, total: sourceFiles.length, filePath: sf.getFilePath() });

        const sfPath = sf.getFilePath().replace(/\\/g, "/");
        const relPath = tsFiles.find(
          (f) => sfPath.endsWith("/" + f.path) || sfPath === f.path,
        )?.path;
        if (!relPath) continue;

        const symbols = extractSymbolsFromSourceFile(sf);
        const content = sf.getFullText();

        // Replace tree-sitter result with richer ts-morph result
        const existingIdx = parsedFiles.findIndex((p) => p.path === relPath);
        const existingErrors = existingIdx >= 0 ? parsedFiles[existingIdx]!.errors : [];
        const parsed: ParsedFile = {
          path: relPath,
          repo,
          kind: "typescript",
          symbols,
          errors: existingErrors,
          contentHash: hashContent(content),
        };

        if (existingIdx >= 0) {
          parsedFiles[existingIdx] = parsed;
        } else {
          parsedFiles.push(parsed);
        }
      }
    } catch (err) {
      console.warn("ts-morph analysis failed:", err);
    }
    tsMorphTimeMs = performance.now() - start;
  }

  let symbolCount = 0;
  let errorCount = 0;
  for (const pf of parsedFiles) {
    symbolCount += pf.symbols.length;
    errorCount += pf.errors.length;
  }

  return {
    parsedFiles,
    treeSitterTrees,
    stats: {
      fileCount: parsedFiles.length,
      symbolCount,
      errorCount,
      treeSitterTimeMs: Math.round(treeSitterTimeMs),
      tsMorphTimeMs: Math.round(tsMorphTimeMs),
    },
  };
}
