/**
 * Unified parsing orchestrator.
 *
 * Phase 1: tree-sitter for all parseable files (fast, syntax-only).
 * Phase 2: ts-morph (optional) for type-resolved symbol extraction.
 *
 * Graceful degradation: either engine can fail independently.
 */

import { readFile } from "node:fs/promises";
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

export interface ParseOptions {
  readonly enableTsMorph?: boolean;
  readonly tsconfigPath?: string;
  readonly onProgress?: (info: ProgressInfo) => void;
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

export async function parseFiles(
  files: readonly ClassifiedFile[],
  repo: string,
  rootDir: string,
  options?: ParseOptions,
): Promise<ParseResult> {
  const parseableFiles = files.filter((f) => isParseable(f.kind));
  const progress = options?.onProgress;
  const parsedFiles: ParsedFile[] = [];
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
    for (let i = 0; i < parseableFiles.length; i++) {
      const file = parseableFiles[i]!;
      progress?.({ phase: "tree-sitter", current: i + 1, total: parseableFiles.length, filePath: file.path });

      try {
        const absPath = join(rootDir, file.path);
        const content = await readFile(absPath, "utf-8");
        const tree = parseSource(content, file.path);
        treeSitterTrees.set(file.path, tree);

        const { symbols, errors } = extractSymbolsFromTree(tree, file.path, repo);
        const kind = classifyFileKind(file.path);
        parsedFiles.push(createParsedFile(file.path, repo, content, kind, symbols, errors));
      } catch (err) {
        console.warn(`tree-sitter parse failed for ${file.path}:`, err);
      }
    }
    treeSitterTimeMs = performance.now() - start;
  }

  // Phase 2: ts-morph (optional, type-resolved)
  if (options?.enableTsMorph) {
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
        const parsed: ParsedFile = {
          path: relPath,
          repo,
          kind: "typescript",
          symbols,
          errors: [],
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
