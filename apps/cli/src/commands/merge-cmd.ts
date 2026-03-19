/**
 * `mma merge` — Combine multiple anonymized export SQLite DBs.
 *
 * Merges kv and edges tables from multiple export DBs into a single output DB.
 * For the `sarif:latest` key, the `.runs` arrays are merged across all inputs.
 * All other kv keys use last-write-wins semantics (INSERT OR REPLACE).
 */

import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { SarifLog } from "@mma/core";

export async function mergeCommand(
  inputPaths: string[],
  outputPath: string,
): Promise<{ kvCount: number; edgeCount: number }> {
  // Validate inputs
  for (const p of inputPaths) {
    if (!existsSync(p)) {
      throw new Error(`Input file not found: ${p}`);
    }
  }

  // Create output DB with the same schema as export
  const destDb = new Database(outputPath);
  destDb.pragma("journal_mode = WAL");
  destDb.exec(`
    DROP TABLE IF EXISTS kv;
    DROP TABLE IF EXISTS edges;
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      metadata TEXT
    );
    CREATE INDEX idx_edges_source ON edges (source);
    CREATE INDEX idx_edges_target ON edges (target);
    CREATE INDEX idx_edges_kind ON edges (kind);
  `);

  const insertKv = destDb.prepare(
    "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
  );
  const insertEdge = destDb.prepare(
    "INSERT INTO edges (source, target, kind, metadata) VALUES (?, ?, ?, ?)",
  );

  // Accumulate merged sarif:latest runs across all inputs
  const mergedSarifRuns: unknown[] = [];

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

  let totalEdges = 0;

  for (const inputPath of inputPaths) {
    const srcDb = new Database(inputPath, { readonly: true });
    try {
      const kvRows = srcDb.prepare("SELECT key, value FROM kv").all() as KvRow[];
      const edgeRows = srcDb
        .prepare("SELECT source, target, kind, metadata FROM edges")
        .all() as EdgeRow[];

      destDb.transaction(() => {
        for (const row of kvRows) {
          if (row.key === "sarif:latest") {
            // Collect runs for later merge; don't insert yet
            try {
              const sarif = JSON.parse(row.value) as SarifLog;
              if (Array.isArray(sarif.runs)) {
                const validRuns = sarif.runs.filter(
                  (run: unknown): run is Record<string, unknown> =>
                    typeof run === "object" && run !== null && "tool" in run,
                );
                mergedSarifRuns.push(...validRuns);
              }
            } catch {
              // Skip malformed SARIF
            }
            continue;
          }
          insertKv.run(row.key, row.value);
        }

        for (const row of edgeRows) {
          insertEdge.run(row.source, row.target, row.kind, row.metadata ?? null);
        }
      })();

      totalEdges += edgeRows.length;
    } finally {
      srcDb.close();
    }
  }

  // Write merged sarif:latest if we collected any runs
  if (mergedSarifRuns.length > 0) {
    const merged: SarifLog = {
      version: "2.1.0",
      $schema:
        "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
      runs: mergedSarifRuns as SarifLog["runs"],
    };
    insertKv.run("sarif:latest", JSON.stringify(merged));
  }

  // Count final kv entries
  const { count: kvCount } = destDb
    .prepare("SELECT COUNT(*) as count FROM kv")
    .get() as { count: number };

  destDb.exec("VACUUM");
  destDb.close();

  console.log(
    `Merged ${inputPaths.length} DB(s) into ${outputPath}: ${kvCount} KV entries, ${totalEdges} edges`,
  );
  return { kvCount, edgeCount: totalEdges };
}
