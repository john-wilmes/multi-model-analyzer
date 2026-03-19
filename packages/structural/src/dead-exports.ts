/**
 * Dead export detection: find exported symbols with no consumers.
 *
 * Detection granularity: file-level. A file's exports are all considered live
 * if *any* other file imports that file. This is a conservative heuristic —
 * it avoids false positives when only a subset of a file's exports are used,
 * but it cannot detect individual dead exports within an imported file.
 *
 * For symbol-level precision, symbol-level import data (e.g. from SCIP or
 * ts-morph named-import extraction) would be required.
 *
 * Entry points (package.json main/bin) are excluded from detection.
 */

import { makeFileId } from "@mma/core";
import type { ParsedFile, GraphEdge, SarifResult } from "@mma/core";

export interface DeadExportOptions {
  readonly entryPoints?: Set<string>;
}

export function detectDeadExports(
  parsedFiles: readonly ParsedFile[],
  importEdges: readonly GraphEdge[],
  repo: string,
  options?: DeadExportOptions,
): SarifResult[] {
  const entryPoints = options?.entryPoints ?? new Set<string>();

  // Build set of all files that are import targets (filtered to this repo)
  const importedFiles = new Set<string>();
  for (const edge of importEdges) {
    if (edge.kind === "imports" && (!edge.metadata?.["repo"] || edge.metadata["repo"] === repo)) {
      importedFiles.add(edge.target);
    }
  }

  const results: SarifResult[] = [];

  for (const pf of parsedFiles) {
    if (pf.repo !== repo) continue;
    // Skip files with no exports
    const exportedSymbols = pf.symbols.filter((s) => s.exported);
    if (exportedSymbols.length === 0) continue;

    // Skip entry points
    if (entryPoints.has(pf.path)) continue;

    // Skip if any file imports this one (file-level heuristic: if the file is
    // imported at all, all its exports are considered reachable)
    if (importedFiles.has(makeFileId(repo, pf.path))) continue;

    // Emit one result per file listing all dead exports
    const symbolList = exportedSymbols
      .map((sym) => `${sym.kind} ${sym.name}`)
      .join(", ");
    results.push({
      ruleId: "structural/dead-export",
      level: "note",
      message: {
        text: `${exportedSymbols.length} dead export(s) in ${pf.path}: ${symbolList}`,
      },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: pf.path },
        },
        logicalLocations: [{
          fullyQualifiedName: pf.path,
          kind: "module",
          properties: { repo },
        }],
      }],
    });
  }

  return results;
}
