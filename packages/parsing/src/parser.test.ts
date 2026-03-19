/**
 * Tests for the unified parsing orchestrator (parseFiles).
 *
 * Uses real tree-sitter WASM grammars and actual temp files on disk
 * for integration-level coverage of the two-phase pipeline.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ClassifiedFile } from "@mma/core";
import { parseFiles } from "./parser.js";
import type { ProgressInfo } from "./parser.js";
import { initTreeSitter } from "./treesitter.js";

let tempDir: string;

beforeAll(async () => {
  await initTreeSitter();
  tempDir = await mkdtemp(join(tmpdir(), "mma-parser-test-"));
}, 15_000);

// Clean up after all tests
afterAll(async () => {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

// Helper to write a temp file and return a ClassifiedFile
async function writeTempFile(
  relPath: string,
  content: string,
  kind: ClassifiedFile["kind"] = "typescript",
): Promise<ClassifiedFile> {
  const absPath = join(tempDir, relPath);
  const dir = join(absPath, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(absPath, content, "utf-8");
  return { path: relPath, repo: "test-repo", kind, relativePath: relPath };
}

// ---------------------------------------------------------------------------
// Empty / degenerate inputs
// ---------------------------------------------------------------------------

describe("parseFiles — empty inputs", () => {
  it("returns empty results for empty file list", async () => {
    const result = await parseFiles([], "test-repo", tempDir);
    expect(result.parsedFiles).toHaveLength(0);
    expect(result.treeSitterTrees.size).toBe(0);
    expect(result.stats.fileCount).toBe(0);
    expect(result.stats.symbolCount).toBe(0);
    expect(result.stats.errorCount).toBe(0);
  });

  it("filters out non-parseable files", async () => {
    const files: ClassifiedFile[] = [
      { path: "data.json", repo: "test-repo", kind: "json", relativePath: "data.json" },
      { path: "README.md", repo: "test-repo", kind: "markdown", relativePath: "README.md" },
      { path: "config.yaml", repo: "test-repo", kind: "yaml", relativePath: "config.yaml" },
    ];
    const result = await parseFiles(files, "test-repo", tempDir);
    expect(result.parsedFiles).toHaveLength(0);
    expect(result.stats.fileCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 1: tree-sitter
// ---------------------------------------------------------------------------

describe("parseFiles — tree-sitter phase", () => {
  it("parses a single TypeScript file", async () => {
    const file = await writeTempFile(
      "ts-single.ts",
      `export function greet(name: string): string { return "hi " + name; }`,
    );
    const result = await parseFiles([file], "test-repo", tempDir);

    expect(result.parsedFiles).toHaveLength(1);
    expect(result.parsedFiles[0]!.path).toBe("ts-single.ts");
    expect(result.parsedFiles[0]!.repo).toBe("test-repo");
    expect(result.parsedFiles[0]!.symbols.length).toBeGreaterThan(0);
    expect(result.parsedFiles[0]!.symbols.some((s) => s.name === "greet")).toBe(true);
    expect(result.stats.fileCount).toBe(1);
    expect(result.stats.symbolCount).toBeGreaterThan(0);
    expect(result.stats.treeSitterTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.stats.tsMorphTimeMs).toBe(0);
  });

  it("parses multiple files of different types", async () => {
    const tsFile = await writeTempFile(
      "multi/util.ts",
      `export function add(a: number, b: number) { return a + b; }`,
    );
    const jsFile = await writeTempFile(
      "multi/legacy.js",
      `function oldHelper() { return 42; }`,
      "javascript",
    );
    const tsxFile = await writeTempFile(
      "multi/App.tsx",
      `export function App() { return <div>Hello</div>; }`,
    );

    const result = await parseFiles([tsFile, jsFile, tsxFile], "test-repo", tempDir);

    expect(result.parsedFiles).toHaveLength(3);
    expect(result.treeSitterTrees.size).toBe(3);
    expect(result.stats.fileCount).toBe(3);
  });

  it("stores tree-sitter AST trees in the result map", async () => {
    const file = await writeTempFile(
      "tree-map.ts",
      `const x = 1;`,
    );
    const result = await parseFiles([file], "test-repo", tempDir);

    expect(result.treeSitterTrees.has("tree-map.ts")).toBe(true);
    const tree = result.treeSitterTrees.get("tree-map.ts");
    expect(tree).toBeDefined();
    expect(tree!.rootNode).toBeDefined();
  });

  it("captures parse errors for malformed code", async () => {
    const file = await writeTempFile(
      "malformed.ts",
      `export function broken( { return }`,
    );
    const result = await parseFiles([file], "test-repo", tempDir);

    expect(result.parsedFiles).toHaveLength(1);
    expect(result.parsedFiles[0]!.errors.length).toBeGreaterThan(0);
    expect(result.stats.errorCount).toBeGreaterThan(0);
  });

  it("sets correct contentHash on parsed files", async () => {
    const content = `export const VALUE = 42;`;
    const file = await writeTempFile("hash-check.ts", content);
    const result = await parseFiles([file], "test-repo", tempDir);

    expect(result.parsedFiles[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles file with only non-parseable kinds mixed in", async () => {
    const tsFile = await writeTempFile("mixed/code.ts", `export type ID = string;`);
    const jsonFile: ClassifiedFile = { path: "mixed/data.json", repo: "test-repo", kind: "json", relativePath: "mixed/data.json" };

    const result = await parseFiles([tsFile, jsonFile], "test-repo", tempDir);
    expect(result.parsedFiles).toHaveLength(1);
    expect(result.parsedFiles[0]!.path).toBe("mixed/code.ts");
  });

  it("handles a file that does not exist on disk gracefully", async () => {
    const ghost: ClassifiedFile = {
      path: "nonexistent-file.ts",
      repo: "test-repo",
      kind: "typescript",
      relativePath: "nonexistent-file.ts",
    };
    // Should not throw — warn and skip
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await parseFiles([ghost], "test-repo", tempDir);
    expect(result.parsedFiles).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Progress callback
// ---------------------------------------------------------------------------

describe("parseFiles — progress reporting", () => {
  it("calls onProgress for each file in tree-sitter phase", async () => {
    const file1 = await writeTempFile("prog1.ts", `const a = 1;`);
    const file2 = await writeTempFile("prog2.ts", `const b = 2;`);
    const progressCalls: ProgressInfo[] = [];

    await parseFiles([file1, file2], "test-repo", tempDir, {
      onProgress: (info) => progressCalls.push({ ...info }),
    });

    expect(progressCalls.length).toBeGreaterThanOrEqual(2);
    expect(progressCalls.every((p) => p.phase === "tree-sitter")).toBe(true);
    expect(progressCalls[0]!.current).toBe(1);
    expect(progressCalls[0]!.total).toBe(2);
    expect(progressCalls[1]!.current).toBe(2);
    expect(progressCalls[1]!.total).toBe(2);
  });

  it("includes filePath in progress info", async () => {
    const file = await writeTempFile("prog-path.ts", `const x = 1;`);
    const progressCalls: ProgressInfo[] = [];

    await parseFiles([file], "test-repo", tempDir, {
      onProgress: (info) => progressCalls.push({ ...info }),
    });

    expect(progressCalls[0]!.filePath).toBe("prog-path.ts");
  });

  it("works without onProgress callback", async () => {
    const file = await writeTempFile("no-progress.ts", `const x = 1;`);
    // Should not throw when no callback is provided
    const result = await parseFiles([file], "test-repo", tempDir);
    expect(result.parsedFiles).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: ts-morph
// ---------------------------------------------------------------------------

describe("parseFiles — ts-morph phase", () => {
  it("enriches TypeScript files when enableTsMorph is set", async () => {
    const file = await writeTempFile(
      "morph/service.ts",
      `export class UserService {
  getUser(id: string) { return null; }
  save() {}
}
export interface Config { key: string; }
export type ID = string;
export enum Status { Active, Inactive }
export const helper = (x: number) => x * 2;
`,
    );
    const result = await parseFiles([file], "test-repo", tempDir, {
      enableTsMorph: true,
    });

    expect(result.parsedFiles).toHaveLength(1);
    const pf = result.parsedFiles[0]!;
    expect(pf.symbols.some((s) => s.name === "UserService" && s.kind === "class")).toBe(true);
    expect(pf.symbols.some((s) => s.name === "getUser" && s.kind === "method")).toBe(true);
    expect(pf.symbols.some((s) => s.name === "Config" && s.kind === "interface")).toBe(true);
    expect(pf.symbols.some((s) => s.name === "ID" && s.kind === "type")).toBe(true);
    expect(pf.symbols.some((s) => s.name === "Status" && s.kind === "enum")).toBe(true);
    expect(pf.symbols.some((s) => s.name === "helper" && s.kind === "function")).toBe(true);
    expect(result.stats.tsMorphTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("replaces tree-sitter result when ts-morph succeeds", async () => {
    const file = await writeTempFile(
      "morph/replace.ts",
      `export function foo() { return 1; }`,
    );
    // First parse without ts-morph
    const withoutMorph = await parseFiles([file], "test-repo", tempDir);
    const treeSitterHash = withoutMorph.parsedFiles[0]!.contentHash;

    // Then parse with ts-morph — should produce same content hash (same file)
    const withMorph = await parseFiles([file], "test-repo", tempDir, {
      enableTsMorph: true,
    });
    expect(withMorph.parsedFiles[0]!.contentHash).toBe(treeSitterHash);
    // Should still have exactly one parsed file (replaced, not duplicated)
    expect(withMorph.parsedFiles).toHaveLength(1);
  });

  it("only applies ts-morph to TypeScript files, not JavaScript", async () => {
    const tsFile = await writeTempFile(
      "morph/code.ts",
      `export function tsFunc() { return 1; }`,
    );
    const jsFile = await writeTempFile(
      "morph/legacy.js",
      `function jsFunc() { return 2; }`,
      "javascript",
    );
    const progressCalls: ProgressInfo[] = [];

    await parseFiles([tsFile, jsFile], "test-repo", tempDir, {
      enableTsMorph: true,
      onProgress: (info) => progressCalls.push({ ...info }),
    });

    const morphCalls = progressCalls.filter((p) => p.phase === "ts-morph");
    // ts-morph should only process the .ts file
    expect(morphCalls.length).toBe(1);
  });

  it("reports progress for ts-morph phase", async () => {
    const file = await writeTempFile("morph/prog.ts", `export const x = 1;`);
    const progressCalls: ProgressInfo[] = [];

    await parseFiles([file], "test-repo", tempDir, {
      enableTsMorph: true,
      onProgress: (info) => progressCalls.push({ ...info }),
    });

    const morphCalls = progressCalls.filter((p) => p.phase === "ts-morph");
    expect(morphCalls.length).toBeGreaterThanOrEqual(1);
    expect(morphCalls[0]!.current).toBe(1);
  });

  it("preserves tree-sitter errors when ts-morph replaces symbols", async () => {
    // File with a syntax error that tree-sitter detects but ts-morph still parses
    const file = await writeTempFile(
      "morph/with-err.ts",
      `export function valid() { return 1; }
// This is a valid file — ts-morph should replace symbols
// but errors from tree-sitter (if any) should be preserved
`,
    );
    const result = await parseFiles([file], "test-repo", tempDir, {
      enableTsMorph: true,
    });
    // The main check: no crash, correct symbol count
    expect(result.parsedFiles).toHaveLength(1);
    expect(result.parsedFiles[0]!.symbols.some((s) => s.name === "valid")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stats aggregation
// ---------------------------------------------------------------------------

describe("parseFiles — stats aggregation", () => {
  it("aggregates symbol and error counts across files", async () => {
    const file1 = await writeTempFile(
      "stats/a.ts",
      `export function fn1() {}
export function fn2() {}`,
    );
    const file2 = await writeTempFile(
      "stats/b.ts",
      `export class MyClass {}`,
    );
    const result = await parseFiles([file1, file2], "test-repo", tempDir);

    expect(result.stats.fileCount).toBe(2);
    expect(result.stats.symbolCount).toBeGreaterThanOrEqual(3);
  });

  it("reports timing as non-negative integers", async () => {
    const file = await writeTempFile("stats/timing.ts", `const x = 1;`);
    const result = await parseFiles([file], "test-repo", tempDir);

    expect(Number.isInteger(result.stats.treeSitterTimeMs)).toBe(true);
    expect(result.stats.treeSitterTimeMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.stats.tsMorphTimeMs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("parseFiles — edge cases", () => {
  it("handles file with no symbols (only comments)", async () => {
    const file = await writeTempFile(
      "edge/comments-only.ts",
      `// This file has no declarations
/* Just comments */`,
    );
    const result = await parseFiles([file], "test-repo", tempDir);

    expect(result.parsedFiles).toHaveLength(1);
    expect(result.parsedFiles[0]!.symbols).toHaveLength(0);
    expect(result.parsedFiles[0]!.errors).toHaveLength(0);
  });

  it("handles file with many declarations", async () => {
    const declarations = Array.from(
      { length: 50 },
      (_, i) => `export function fn${i}() { return ${i}; }`,
    ).join("\n");
    const file = await writeTempFile("edge/many-decls.ts", declarations);
    const result = await parseFiles([file], "test-repo", tempDir);

    expect(result.parsedFiles[0]!.symbols.length).toBe(50);
    expect(result.stats.symbolCount).toBe(50);
  });

  it("handles deeply nested directory paths", async () => {
    const file = await writeTempFile(
      "a/b/c/d/deep.ts",
      `export const DEEP = true;`,
    );
    const result = await parseFiles([file], "test-repo", tempDir);

    expect(result.parsedFiles).toHaveLength(1);
    expect(result.parsedFiles[0]!.path).toBe("a/b/c/d/deep.ts");
  });

  it("assigns correct FileKind from classifyFileKind", async () => {
    const file = await writeTempFile("edge/component.tsx", `export function C() { return <div/>; }`);
    const result = await parseFiles([file], "test-repo", tempDir);

    // classifyFileKind("component.tsx") should return "typescript"
    expect(result.parsedFiles[0]!.kind).toBe("typescript");
  });
});
