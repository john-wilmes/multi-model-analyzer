/**
 * Benchmarks for detectPatterns.
 *
 * Synthetic inputs are constructed at module scope with deterministic,
 * index-based naming.  No tree-sitter or I/O enters the measured path.
 *
 * Each file contains a mix of symbol kinds so that all pattern rules
 * (naming, structural observer/singleton/builder/strategy) fire on at
 * least a fraction of the input.
 */

import { bench, describe } from "vitest";
import { detectPatterns } from "./patterns.js";
import type { PatternDetectionInput } from "./patterns.js";
import type { SymbolInfo } from "@mma/core";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makePath(i: number): string {
  return `src/module-${i}.ts`;
}

/**
 * Create a deterministic symbol set for one file.
 * Cycles through a variety of symbol kinds so that:
 *   - i % 11 === 0  → name ends in "Adapter"   (adapter rule)
 *   - i % 11 === 1  → name ends in "Factory"   (factory rule)
 *   - i % 11 === 2  → name ends in "Repository" (repository rule)
 *   - i % 11 === 3  → has getInstance method   (singleton structural)
 *   - i % 11 === 4  → has subscribe+emit       (observer structural)
 *   - otherwise     → plain class + function   (no pattern match)
 */
function makeSymbols(i: number): readonly SymbolInfo[] {
  const mod = i % 11;

  if (mod === 0) {
    return [
      { name: `Module${i}Adapter`, kind: "class", startLine: 1, endLine: 30, exported: true },
    ];
  }
  if (mod === 1) {
    return [
      { name: `Widget${i}Factory`, kind: "class", startLine: 1, endLine: 30, exported: true },
    ];
  }
  if (mod === 2) {
    return [
      { name: `User${i}Repository`, kind: "class", startLine: 1, endLine: 30, exported: true },
    ];
  }
  if (mod === 3) {
    // Singleton: class + getInstance method
    return [
      { name: `Service${i}`, kind: "class", startLine: 1, endLine: 50, exported: true },
      { name: "getInstance", kind: "method", startLine: 5, endLine: 10, exported: false, containerName: `Service${i}` },
    ];
  }
  if (mod === 4) {
    // Observer: class + subscribe + emit methods
    return [
      { name: `EventBus${i}`, kind: "class", startLine: 1, endLine: 60, exported: true },
      { name: "subscribe", kind: "method", startLine: 5, endLine: 10, exported: false, containerName: `EventBus${i}` },
      { name: "emit", kind: "method", startLine: 12, endLine: 18, exported: false, containerName: `EventBus${i}` },
    ];
  }
  // Default: no pattern match
  return [
    { name: `Module${i}`, kind: "class", startLine: 1, endLine: 20, exported: true },
    { name: `doWork${i}`, kind: "function", startLine: 22, endLine: 30, exported: false },
  ];
}

function buildInput(n: number): PatternDetectionInput {
  const symbols = new Map<string, readonly SymbolInfo[]>();
  const imports = new Map<string, readonly string[]>();

  for (let i = 0; i < n; i++) {
    const path = makePath(i);
    symbols.set(path, makeSymbols(i));
    // Minimal imports: each file imports the next (not used by detectPatterns but
    // keeps the input structurally realistic)
    imports.set(path, [`./module-${(i + 1) % n}`]);
  }

  return { repo: "bench-repo", symbols, imports };
}

// ---------------------------------------------------------------------------
// Pre-built fixtures
// ---------------------------------------------------------------------------

const input100 = buildInput(100);
const input500 = buildInput(500);

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe("detectPatterns", () => {
  bench("100 files", () => {
    detectPatterns(input100);
  });

  bench("500 files", () => {
    detectPatterns(input500);
  });
});
