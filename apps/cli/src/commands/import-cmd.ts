/**
 * `mma import` — Import a raw MMA export into the local database.
 *
 * Reads KV entries and graph edges from a raw export DB and writes them
 * into the local stores. The incremental index pipeline will then only
 * reprocess files that changed since the baseline commit.
 */

import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { KVStore, GraphStore } from "@mma/storage";
import type { GraphEdge } from "@mma/core";
import type { ExportManifest } from "./export-cmd.js";

export interface ImportOptions {
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly input: string;
  readonly configRepos?: readonly string[];
  readonly verbose?: boolean;
}

interface KvRow {
  key: string;
  value: string;
}

interface EdgeRow {
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
}

export async function importCommand(
  options: ImportOptions,
): Promise<{ kvCount: number; edgeCount: number }> {
  const { kvStore, graphStore, input, configRepos, verbose } = options;

  // 1. Validate file exists
  if (!existsSync(input)) {
    throw new Error(`Input file not found: ${input}`);
  }

  // 2. Open source DB read-only
  const srcDb = new Database(input, { readonly: true });

  try {
    // 3. Read and validate manifest
    const manifestRow = srcDb
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get("mma:manifest") as KvRow | undefined;

    if (!manifestRow) {
      throw new Error(
        'Not a valid MMA export (no manifest). Was this created with `mma export --raw`?',
      );
    }

    const manifest = JSON.parse(manifestRow.value) as ExportManifest;

    if (manifest.mode !== "raw") {
      throw new Error(
        "Cannot import anonymized export. Use `mma export --raw`.",
      );
    }

    if (manifest.schemaVersion > 1) {
      throw new Error(
        `Unsupported schema version ${manifest.schemaVersion}. Upgrade MMA.`,
      );
    }

    // 4. Warn on repo mismatches
    if (configRepos && configRepos.length > 0) {
      const exportRepoNames = new Set(manifest.repos.map((r) => r.name));
      const configRepoNames = new Set(configRepos);

      const inExportOnly = [...exportRepoNames].filter(
        (r) => !configRepoNames.has(r),
      );
      const inConfigOnly = [...configRepoNames].filter(
        (r) => !exportRepoNames.has(r),
      );

      if (inExportOnly.length > 0) {
        console.warn(
          `Warning: repos in baseline but not in config: ${inExportOnly.join(", ")}`,
        );
      }
      if (inConfigOnly.length > 0) {
        console.warn(
          `Warning: repos in config but not in baseline: ${inConfigOnly.join(", ")}`,
        );
      }
    }

    // 5. Read all KV rows (excluding manifest) and write to local store
    const kvRows = srcDb
      .prepare("SELECT key, value FROM kv WHERE key != ?")
      .all("mma:manifest") as KvRow[];

    for (const row of kvRows) {
      await kvStore.set(row.key, row.value);
    }

    // 6. Read all edges and batch write to graph store
    const edgeRows = srcDb
      .prepare("SELECT source, target, kind, metadata FROM edges")
      .all() as EdgeRow[];

    if (edgeRows.length > 0) {
      const edges: GraphEdge[] = edgeRows.map((row) => ({
        source: row.source,
        target: row.target,
        kind: row.kind as GraphEdge["kind"],
        metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
      }));
      await graphStore.addEdges(edges);
    }

    // 7. Print summary
    const repoList = manifest.repos.map((r) => r.name).join(", ");
    if (verbose) {
      console.log(`Imported from: ${input}`);
      console.log(`  KV entries: ${kvRows.length}`);
      console.log(`  Edges: ${edgeRows.length}`);
      console.log(`  Repos: ${repoList}`);
      console.log(`  Baseline date: ${manifest.exportedAt}`);
    } else {
      console.log(
        `Imported ${kvRows.length} KV entries and ${edgeRows.length} edges from ${manifest.repos.length} repo(s)`,
      );
    }

    console.log(
      "\nRun `mma index -c mma.config.json` to incrementally update from this baseline.",
    );

    return { kvCount: kvRows.length, edgeCount: edgeRows.length };
  } finally {
    srcDb.close();
  }
}
