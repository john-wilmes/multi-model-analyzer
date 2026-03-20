/**
 * Hotspot analysis: files that have both high git churn and high complexity
 * (measured by symbol count) are flagged as hotspots.
 *
 * Score = average of two independently-normalised dimensions:
 *   churnScore      = (churn / maxChurn) * 100
 *   complexityScore = (symbolCount / maxSymbolCount) * 100
 *   hotspotScore    = round((churnScore + complexityScore) / 2)
 *
 * Normalising independently prevents a single outlier in one dimension
 * (e.g. a machine-generated file with 1000+ symbols) from collapsing all
 * other scores to near-zero.
 */

/** A single {commit, file} entry from git log — mirrors CommitFileChange in @mma/ingestion */
export interface CommitFileChange {
  readonly hash: string;
  readonly filePath: string;
}

export interface FileHotspot {
  readonly filePath: string;
  /** Number of commits that touched this file */
  readonly churn: number;
  /** Complexity proxy: number of symbols in the file */
  readonly symbolCount: number;
  /** Average of independently-normalised churn and complexity scores, 0-100 */
  readonly hotspotScore: number;
}

export interface HotspotResult {
  /** Top-N hotspots sorted by score descending */
  readonly hotspots: FileHotspot[];
  readonly maxChurn: number;
  readonly maxSymbolCount: number;
}

/**
 * Compute hotspots from git history and per-file symbol counts.
 *
 * @param fileChanges  Flat list of {hash, filePath} from getCommitHistory().
 * @param symbolCounts Map of filePath -> symbol count (from parsedFiles).
 * @param topN         Maximum number of hotspots to return (default 20).
 */
export function computeHotspots(
  fileChanges: readonly CommitFileChange[],
  symbolCounts: Map<string, number>,
  topN: number = 20,
): HotspotResult {
  // Count distinct commits per file
  const commitsByFile = new Map<string, Set<string>>();
  for (const { hash, filePath } of fileChanges) {
    let hashes = commitsByFile.get(filePath);
    if (!hashes) {
      hashes = new Set<string>();
      commitsByFile.set(filePath, hashes);
    }
    hashes.add(hash);
  }

  // Build hotspot entries — skip files with no symbol data
  interface RawEntry {
    filePath: string;
    churn: number;
    symbolCount: number;
  }

  const entries: RawEntry[] = [];
  let maxChurn = 0;
  let maxSymbolCount = 0;

  for (const [filePath, hashes] of commitsByFile) {
    const churn = hashes.size;
    const symbolCount = symbolCounts.get(filePath) ?? 0;

    // Filter out non-source files (no symbols = config, docs, etc.)
    if (symbolCount === 0) continue;

    // Filter out test/spec/e2e files — high churn on tests is expected and
    // doesn't indicate a maintenance hotspot in production code.
    if (isTestFile(filePath)) continue;

    entries.push({ filePath, churn, symbolCount });

    if (churn > maxChurn) maxChurn = churn;
    if (symbolCount > maxSymbolCount) maxSymbolCount = symbolCount;
  }

  if (entries.length === 0) {
    return { hotspots: [], maxChurn, maxSymbolCount };
  }

  // Normalise churn and symbolCount independently, then average.
  // This prevents a single outlier in one dimension from collapsing all
  // other scores to near-zero.
  const hotspots: FileHotspot[] = entries
    .map((e) => {
      const churnScore = maxChurn > 0 ? (e.churn / maxChurn) * 100 : 0;
      const complexityScore =
        maxSymbolCount > 0 ? (e.symbolCount / maxSymbolCount) * 100 : 0;
      return {
        filePath: e.filePath,
        churn: e.churn,
        symbolCount: e.symbolCount,
        hotspotScore: Math.round((churnScore + complexityScore) / 2),
      };
    })
    .sort((a, b) => b.hotspotScore - a.hotspotScore || b.churn - a.churn)
    .slice(0, topN);

  return { hotspots, maxChurn, maxSymbolCount };
}

const TEST_FILE_RE = /(?:\.(?:test|spec|e2e)\.(?:[cm]?[jt]sx?)$|(?:^|[/\\])(?:__tests__|__mocks__|test|tests|e2e)(?:[/\\]|$))/;

function isTestFile(filePath: string): boolean {
  return TEST_FILE_RE.test(filePath);
}
