/**
 * Cross-repo symbol resolution.
 *
 * Builds an export index from KV-stored symbol data and resolves imported
 * symbol names on cross-repo edges to their canonical file IDs and kinds.
 *
 * @see symbol-resolver.test.ts for unit tests.
 */

import type { KVStore } from "@mma/storage";
import type { RepoConfig, SymbolInfo } from "@mma/core";
import { makeFileId } from "@mma/core";
import type { ResolvedCrossRepoEdge, ResolvedImportedSymbol } from "./types.js";

/** Shape of the KV entry for `symbols:<repo>:<file>`. */
interface SymbolsEntry {
  symbols: SymbolInfo[];
  contentHash: string;
  kind?: string;
}

/** Map from fileId -> symbolName -> { kind } for exported symbols only. */
export type ExportIndex = Map<string, Map<string, { kind: string }>>;

/**
 * Bulk-read `symbols:<repo>:<file>` entries from KV for all repos and build
 * an index of exported symbols keyed by file ID.
 */
export async function buildExportIndex(
  kvStore: KVStore,
  repos: readonly RepoConfig[],
): Promise<ExportIndex> {
  const index: ExportIndex = new Map();

  for (const repo of repos) {
    const prefix = `symbols:${repo.name}:`;
    const entries = await kvStore.getByPrefix(prefix);
    for (const [key, raw] of entries) {
      const filePath = key.slice(prefix.length);
      const fileId = makeFileId(repo.name, filePath);
      let entry: SymbolsEntry;
      try {
        entry = JSON.parse(raw) as SymbolsEntry;
      } catch {
        continue;
      }
      const exportedSymbols = new Map<string, { kind: string }>();
      for (const sym of entry.symbols) {
        if (sym.exported) {
          exportedSymbols.set(sym.name, { kind: sym.kind as string });
        }
      }
      if (exportedSymbols.size > 0) {
        index.set(fileId, exportedSymbols);
      }
    }
  }

  return index;
}

/**
 * Resolve imported symbol names on cross-repo edges.
 *
 * For each edge that has `metadata.importedNames`, look up the target file's
 * exports in the export index and attach `metadata.resolvedSymbols`.
 *
 * @param edges - Cross-repo edges to annotate (mutated in place via the
 *   mutable cast — GraphEdge.metadata is `Record<string, unknown>`).
 * @param exportIndex - Pre-built export index from {@link buildExportIndex}.
 * @param barrelSources - Map from barrel fileId -> source fileIds it re-exports.
 * @returns Total count of resolved symbol bindings.
 */
export function resolveSymbolsOnEdges(
  edges: readonly ResolvedCrossRepoEdge[],
  exportIndex: ExportIndex,
  barrelSources: Map<string, string[]>,
): number {
  let totalResolved = 0;

  for (const resolved of edges) {
    const meta = resolved.edge.metadata as Record<string, unknown>;
    const importedNames = meta?.importedNames;
    if (!Array.isArray(importedNames) || importedNames.length === 0) {
      continue;
    }

    const targetFileId = resolved.edge.target;
    const targetExports = exportIndex.get(targetFileId);
    const barrelExportSources = barrelSources.get(targetFileId);

    const resolvedSymbols: ResolvedImportedSymbol[] = [];

    for (const name of importedNames as string[]) {
      if (name === "*") {
        // Resolve all exports from the target file.
        if (targetExports) {
          for (const [symName, symInfo] of targetExports) {
            resolvedSymbols.push({
              name: symName,
              targetFileId,
              kind: symInfo.kind,
            });
          }
        }
        // Also expand barrel re-exports.
        if (barrelExportSources) {
          for (const srcFileId of barrelExportSources) {
            const srcExports = exportIndex.get(srcFileId);
            if (srcExports) {
              for (const [symName, symInfo] of srcExports) {
                resolvedSymbols.push({
                  name: symName,
                  targetFileId: srcFileId,
                  kind: symInfo.kind,
                });
              }
            }
          }
        }
        continue;
      }

      if (name === "default") {
        // Look for an explicit "default" export or fall back to the first export.
        if (targetExports) {
          const defaultSym = targetExports.get("default");
          if (defaultSym) {
            resolvedSymbols.push({ name: "default", targetFileId, kind: defaultSym.kind });
            continue;
          }
          // Fall back to first export as a proxy for the default export.
          const first = targetExports.entries().next();
          if (!first.done) {
            const [symName, symInfo] = first.value;
            resolvedSymbols.push({ name: symName, targetFileId, kind: symInfo.kind });
            continue;
          }
        }
        continue;
      }

      // Named import: direct lookup in the target file's exports.
      if (targetExports) {
        const sym = targetExports.get(name);
        if (sym) {
          resolvedSymbols.push({ name, targetFileId, kind: sym.kind });
          continue;
        }
      }

      // One-hop barrel resolution: check each file the barrel re-exports from.
      if (barrelExportSources) {
        for (const srcFileId of barrelExportSources) {
          const srcExports = exportIndex.get(srcFileId);
          if (srcExports) {
            const sym = srcExports.get(name);
            if (sym) {
              resolvedSymbols.push({ name, targetFileId: srcFileId, kind: sym.kind });
              break;
            }
          }
        }
      }
    }

    if (resolvedSymbols.length > 0) {
      meta.resolvedSymbols = resolvedSymbols;
      totalResolved += resolvedSymbols.length;
    }
  }

  return totalResolved;
}
