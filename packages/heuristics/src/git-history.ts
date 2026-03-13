/**
 * Git history analysis utilities for temporal coupling detection.
 * Extracts co-change pairs from commit history within a time window.
 */

export interface CommitInfo {
  readonly hash: string;
  readonly timestamp: Date;
  readonly files: readonly string[];
}

export interface CoChangePair {
  readonly fileA: string;
  readonly fileB: string;
  readonly count: number;
}

/**
 * Check if two commits fall within the same time window.
 * Used to group related changes for co-change analysis.
 */
export function withinWindow(a: Date, b: Date, windowMs: number): boolean {
  return Math.abs(a.getTime() - b.getTime()) < windowMs;
}

/**
 * Extract file pairs that changed together in a commit.
 * Returns all unique (unordered) pairs of files from the file list.
 */
export function extractPairs(files: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const sorted = [files[i]!, files[j]!].sort();
      pairs.push([sorted[0]!, sorted[1]!]);
    }
  }
  return pairs;
}
