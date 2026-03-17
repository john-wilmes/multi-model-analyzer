/**
 * Hotspot analysis: files that have both high git churn and high complexity
 * (measured by symbol count) are flagged as hotspots.
 *
 * Score = churn * symbolCount, normalised to 0-100 relative to the maximum
 * raw score in the dataset.
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
  /** churn * symbolCount, normalised 0-100 */
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

  // Build raw hotspot entries — skip files with no symbol data
  interface RawEntry {
    filePath: string;
    churn: number;
    symbolCount: number;
    rawScore: number;
  }

  const entries: RawEntry[] = [];
  let maxChurn = 0;
  let maxSymbolCount = 0;

  for (const [filePath, hashes] of commitsByFile) {
    const churn = hashes.size;
    const symbolCount = symbolCounts.get(filePath) ?? 0;

    // Filter out non-source files (no symbols = config, docs, etc.)
    if (symbolCount === 0) continue;

    const rawScore = churn * symbolCount;
    entries.push({ filePath, churn, symbolCount, rawScore });

    if (churn > maxChurn) maxChurn = churn;
    if (symbolCount > maxSymbolCount) maxSymbolCount = symbolCount;
  }

  if (entries.length === 0) {
    return { hotspots: [], maxChurn, maxSymbolCount };
  }

  // Find maximum raw score for normalisation
  const maxRaw = Math.max(...entries.map((e) => e.rawScore));

  // Normalise and sort
  const hotspots: FileHotspot[] = entries
    .map((e) => ({
      filePath: e.filePath,
      churn: e.churn,
      symbolCount: e.symbolCount,
      hotspotScore: maxRaw > 0 ? Math.round((e.rawScore / maxRaw) * 100) : 0,
    }))
    .sort((a, b) => b.hotspotScore - a.hotspotScore || b.churn - a.churn)
    .slice(0, topN);

  return { hotspots, maxChurn, maxSymbolCount };
}
