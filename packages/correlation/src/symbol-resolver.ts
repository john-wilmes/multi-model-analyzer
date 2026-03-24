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
import { extractPackageName } from "./connection-discovery.js";

/** Map from npm package name -> candidate entry file IDs (barrels, index files). */
export type PackageEntryMap = Map<string, string[]>;

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
 * Generate candidate file IDs for a deep import subpath.
 * E.g. targetRepo="shared-types", subpath="out/constants"
 * → ["shared-types:out/constants.ts", "shared-types:out/constants.js",
 *    "shared-types:out/constants/index.ts", "shared-types:out/constants/index.js",
 *    "shared-types:out/constants.tsx"]
 */
function subpathCandidates(targetRepo: string, subpath: string): string[] {
  const exts = [".ts", ".js", "/index.ts", "/index.js", ".tsx"];
  return exts.map((ext) => makeFileId(targetRepo, subpath + ext));
}

/**
 * Find the effective target file IDs and exports for a cross-repo edge.
 *
 * For edges whose target is already a canonical file ID (e.g. `repo:src/file.ts`),
 * returns the direct export index entry. For npm package specifiers (e.g.
 * `@supabase/ssr` or `@supabase/shared-types/out/constants`), resolves via
 * the packageEntryMap or subpath candidate generation.
 */
function findTargetExports(
  resolved: ResolvedCrossRepoEdge,
  exportIndex: ExportIndex,
  barrelSources: Map<string, string[]>,
  packageEntryMap: PackageEntryMap,
): { targetExports: Map<string, { kind: string }> | undefined; barrelExportSources: string[] | undefined; effectiveFileId: string } {
  const rawTarget = resolved.edge.target;

  // Fast path: target is already a canonical file ID in the export index
  const directExports = exportIndex.get(rawTarget);
  if (directExports) {
    return {
      targetExports: directExports,
      barrelExportSources: barrelSources.get(rawTarget),
      effectiveFileId: rawTarget,
    };
  }

  // If the target looks like a file ID (contains ":") and has barrel sources,
  // return those even if the file itself has no exports in the index.
  const directBarrel = barrelSources.get(rawTarget);
  if (directBarrel) {
    return {
      targetExports: undefined,
      barrelExportSources: directBarrel,
      effectiveFileId: rawTarget,
    };
  }

  // Package specifier path: extract subpath after package name
  const packageName = resolved.packageName ?? extractPackageName(rawTarget);
  if (!packageName) {
    return { targetExports: undefined, barrelExportSources: undefined, effectiveFileId: rawTarget };
  }

  const subpath = rawTarget.slice(packageName.length).replace(/^\//, "");

  if (subpath) {
    // Deep import: try subpath candidates (e.g. shared-types:out/constants.ts)
    const candidates = subpathCandidates(resolved.targetRepo, subpath);
    for (const candidate of candidates) {
      const exports = exportIndex.get(candidate);
      if (exports) {
        return {
          targetExports: exports,
          barrelExportSources: barrelSources.get(candidate),
          effectiveFileId: candidate,
        };
      }
    }
  } else {
    // Top-level package import: use packageEntryMap barrel files
    const entryFileIds = packageEntryMap.get(packageName);
    if (entryFileIds) {
      for (const entryId of entryFileIds) {
        const exports = exportIndex.get(entryId);
        if (exports) {
          return {
            targetExports: exports,
            barrelExportSources: barrelSources.get(entryId),
            effectiveFileId: entryId,
          };
        }
      }
      // Even if no direct exports, check barrel sources for the first entry
      for (const entryId of entryFileIds) {
        const bs = barrelSources.get(entryId);
        if (bs) {
          return {
            targetExports: undefined,
            barrelExportSources: bs,
            effectiveFileId: entryId,
          };
        }
      }
    }
  }

  return { targetExports: undefined, barrelExportSources: undefined, effectiveFileId: rawTarget };
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
 * @param packageEntryMap - Map from npm package name -> candidate entry file IDs.
 * @returns Total count of resolved symbol bindings.
 */
export function resolveSymbolsOnEdges(
  edges: readonly ResolvedCrossRepoEdge[],
  exportIndex: ExportIndex,
  barrelSources: Map<string, string[]>,
  packageEntryMap: PackageEntryMap = new Map(),
): number {
  let totalResolved = 0;

  for (const resolved of edges) {
    const meta = resolved.edge.metadata as Record<string, unknown>;
    const importedNames = meta?.importedNames;
    if (!Array.isArray(importedNames) || importedNames.length === 0) {
      continue;
    }

    const { targetExports, barrelExportSources, effectiveFileId } = findTargetExports(
      resolved,
      exportIndex,
      barrelSources,
      packageEntryMap,
    );
    const targetFileId = effectiveFileId;

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
