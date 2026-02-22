/**
 * Dead export detection: find exported symbols with no consumers.
 *
 * A file's exports are "dead" if no other file imports that file.
 * Entry points (package.json main/bin) are excluded from detection.
 */

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

  // Build set of all files that are import targets
  const importedFiles = new Set<string>();
  for (const edge of importEdges) {
    if (edge.kind === "imports") {
      importedFiles.add(edge.target);
    }
  }

  const results: SarifResult[] = [];

  for (const pf of parsedFiles) {
    // Skip files with no exports
    const exportedSymbols = pf.symbols.filter((s) => s.exported);
    if (exportedSymbols.length === 0) continue;

    // Skip entry points
    if (entryPoints.has(pf.path)) continue;

    // Skip if any file imports this one
    if (importedFiles.has(pf.path)) continue;

    // Flag each exported symbol
    for (const sym of exportedSymbols) {
      results.push({
        ruleId: "structural/dead-export",
        level: "note",
        message: {
          text: `Exported ${sym.kind} "${sym.name}" in ${pf.path} is not imported by any other file`,
        },
        locations: [{
          logicalLocations: [{
            fullyQualifiedName: `${pf.path}#${sym.name}`,
            kind: sym.kind,
            properties: { repo },
          }],
        }],
      });
    }
  }

  return results;
}
