/**
 * Benchmarks for the dependency graph module.
 *
 * extractDependencyGraph requires tree-sitter Tree objects which depend on
 * WASM; those are stubbed with empty namedChildren so no I/O enters the
 * measured path.  The algorithmic work under test is:
 *   - resolveImportSpecifier: pure path-resolution over a known-paths set
 *   - extractDependencyGraph: full pipeline including circular detection
 *
 * Fixtures are constructed deterministically at module scope.
 */

import { bench, describe } from "vitest";
import { resolveImportSpecifier, extractDependencyGraph } from "./dependencies.js";
import type { TreeSitterTree, TreeSitterNode } from "@mma/parsing";

// ---------------------------------------------------------------------------
// Minimal stub for TreeSitterTree / TreeSitterNode
// We only need to satisfy the shape used inside extractImports():
//   rootNode.namedChildren  (iterated for import_statement / expression_statement)
// Returning an empty array means no import edges are produced, so the
// circular-detection pass runs over 0 edges — that still exercises the
// full extractDependencyGraph call path.
// ---------------------------------------------------------------------------

function makeStubTree(): TreeSitterTree {
  const stubNode = {
    namedChildren: [],
    type: "program",
    text: "",
  } as unknown as TreeSitterNode;

  return {
    rootNode: stubNode,
  } as unknown as TreeSitterTree;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePath(i: number): string {
  return `src/module-${i}.ts`;
}

/** Build a ReadonlyMap<filePath, TreeSitterTree> for N stub files. */
function buildStubTrees(n: number): ReadonlyMap<string, TreeSitterTree> {
  const map = new Map<string, TreeSitterTree>();
  for (let i = 0; i < n; i++) {
    map.set(makePath(i), makeStubTree());
  }
  return map;
}

/** Build a Set<string> of known paths for resolveImportSpecifier calls. */
function buildKnownPathsSet(n: number): ReadonlySet<string> {
  const arr: string[] = [];
  for (let i = 0; i < n; i++) arr.push(makePath(i));
  return new Set(arr);
}

/** Specifiers to resolve: half relative, half bare. */
function buildSpecifiers(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(i % 2 === 0 ? `./module-${(i + 1) % n}` : `@org/pkg`);
  }
  return out;
}

const trees50 = buildStubTrees(50);
const trees200 = buildStubTrees(200);

const knownPaths50 = buildKnownPathsSet(50);
const knownPaths200 = buildKnownPathsSet(200);

const specifiers50 = buildSpecifiers(50);
const specifiers200 = buildSpecifiers(200);

// Importer path used for relative resolution
const IMPORTER = "src/entry.ts";

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe("resolveImportSpecifier", () => {
  bench("50 resolutions", () => {
    for (const spec of specifiers50) {
      resolveImportSpecifier(spec, IMPORTER, knownPaths50);
    }
  });

  bench("200 resolutions", () => {
    for (const spec of specifiers200) {
      resolveImportSpecifier(spec, IMPORTER, knownPaths200);
    }
  });
});

describe("extractDependencyGraph (stub trees, circular detection)", () => {
  bench("50 files", () => {
    extractDependencyGraph(trees50, "bench-repo");
  });

  bench("200 files", () => {
    extractDependencyGraph(trees200, "bench-repo");
  });
});
