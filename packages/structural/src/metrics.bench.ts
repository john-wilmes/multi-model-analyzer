/**
 * Benchmarks for computeModuleMetrics.
 *
 * Synthetic graphs are generated deterministically at module scope using
 * index-based naming so fixture construction does not skew results.
 */

import { bench, describe } from "vitest";
import { computeModuleMetrics } from "./metrics.js";
import type { GraphEdge, ParsedFile } from "@mma/core";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makePath(i: number): string {
  return `src/module-${i}.ts`;
}

/**
 * Build a synthetic edge list for N modules.
 * Each module i imports module (i+1) % N and (i+2) % N, giving a
 * mix of afferent / efferent coupling without obvious hotspots.
 */
function buildEdges(n: number): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (let i = 0; i < n; i++) {
    edges.push({ source: makePath(i), target: makePath((i + 1) % n), kind: "imports" });
    edges.push({ source: makePath(i), target: makePath((i + 2) % n), kind: "imports" });
  }
  return edges;
}

/**
 * Build synthetic ParsedFile array for N modules.
 * Alternates between concrete-only and half-abstract symbol sets so
 * abstractness varies across the graph.
 */
function buildParsedFiles(n: number): ParsedFile[] {
  const files: ParsedFile[] = [];
  for (let i = 0; i < n; i++) {
    const symbols: ParsedFile["symbols"] = i % 2 === 0
      ? [
          { name: `Class${i}`, kind: "class", startLine: 1, endLine: 20, exported: true },
          { name: `func${i}`, kind: "function", startLine: 22, endLine: 30, exported: false },
        ]
      : [
          { name: `Interface${i}`, kind: "interface", startLine: 1, endLine: 10, exported: true },
          { name: `Type${i}`, kind: "type", startLine: 12, endLine: 12, exported: true },
        ];
    files.push({
      path: makePath(i),
      repo: "bench-repo",
      kind: "typescript",
      symbols,
      errors: [],
      contentHash: `hash-${i}`,
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Pre-built fixtures (deterministic, constructed once at module scope)
// ---------------------------------------------------------------------------

const edges100 = buildEdges(100);
const files100 = buildParsedFiles(100);

const edges500 = buildEdges(500);
const files500 = buildParsedFiles(500);

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe("computeModuleMetrics", () => {
  bench("100 modules", () => {
    computeModuleMetrics(edges100, files100, "bench-repo");
  });

  bench("500 modules", () => {
    computeModuleMetrics(edges500, files500, "bench-repo");
  });
});
