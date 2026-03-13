/**
 * Benchmarks for detectTemporalCoupling.
 *
 * Synthetic commit histories are constructed at module scope using
 * deterministic, index-based naming.  No I/O or tree-sitter enters
 * the measured path.
 *
 * Three scenarios are benchmarked:
 *   - 200 commits, default options (minCoChanges=3, minConfidence=0.5)
 *   - 1000 commits, default options
 *   - 1000 commits, strict filter (minCoChanges=10, minConfidence=0.8)
 *
 * Commit structure: each commit touches 3–5 files from a pool of 20,
 * with the pool index cycling deterministically so co-change counts
 * accumulate naturally and the pair-filtering pass has real work to do.
 */

import { bench, describe } from "vitest";
import { detectTemporalCoupling } from "./temporal-coupling.js";
import type { CommitInfo, TemporalCouplingOptions } from "./temporal-coupling.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FILE_POOL_SIZE = 20;

function makeFile(i: number): string {
  return `src/module-${i % FILE_POOL_SIZE}.ts`;
}

/**
 * Build N synthetic commits.
 * Each commit touches files at indices [i % P, (i+1) % P, (i+2) % P]
 * where P = FILE_POOL_SIZE.  Every 7th commit also touches (i+3) % P
 * and (i+4) % P to simulate larger changesets.
 * This creates genuine co-change patterns without randomness.
 */
function buildCommits(n: number): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (let i = 0; i < n; i++) {
    const files: string[] = [
      makeFile(i),
      makeFile(i + 1),
      makeFile(i + 2),
    ];
    if (i % 7 === 0) {
      files.push(makeFile(i + 3));
      files.push(makeFile(i + 4));
    }
    // Deduplicate (when pool wraps, same path can appear twice)
    const unique = [...new Set(files)];
    commits.push({ hash: `commit-${i}`, files: unique });
  }
  return commits;
}

// ---------------------------------------------------------------------------
// Pre-built fixtures
// ---------------------------------------------------------------------------

const commits200 = buildCommits(200);
const commits1000 = buildCommits(1000);

const defaultOpts: TemporalCouplingOptions = {};
const strictOpts: TemporalCouplingOptions = { minCoChanges: 10, minConfidence: 0.8 };

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe("detectTemporalCoupling", () => {
  bench("200 commits, default options", () => {
    detectTemporalCoupling(commits200, defaultOpts);
  });

  bench("1000 commits, default options", () => {
    detectTemporalCoupling(commits1000, defaultOpts);
  });

  bench("1000 commits, strict filter", () => {
    detectTemporalCoupling(commits1000, strictOpts);
  });
});
