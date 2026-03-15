/**
 * `mma export` — Anonymized SQLite database export.
 *
 * Creates a portable, anonymized copy of the analysis database
 * with all repo names, file paths, and symbol names hashed.
 * The output contains kv and edges tables only (no FTS).
 */

import Database from "better-sqlite3";
import type { EdgeKind, SarifLog } from "@mma/core";
import type { KVStore, GraphStore } from "@mma/storage";
import { discoverRepos } from "@mma/storage";
import { hashToken, redactSarifLog } from "@mma/diagnostics";

export interface ExportOptions {
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly output: string;
  readonly salt: string;
  readonly raw?: boolean;
}

export interface ExportManifest {
  readonly schemaVersion: number;
  readonly exportedAt: string;
  readonly mode: "raw" | "anonymized";
  readonly repos: ReadonlyArray<{ name: string; commit: string }>;
}

/** KV key prefixes to skip (too granular / no analytical value). */
const SKIP_PREFIXES = ["symbols:", "pipelineComplete:"];

const EDGE_KINDS: readonly EdgeKind[] = [
  "imports",
  "calls",
  "extends",
  "implements",
  "depends-on",
  "contains",
  "service-call",
];

const FILE_PATH_RE =
  /(?:\.\/|\.\.\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|mjs|cjs)\b/g;

const SERVICE_NAME_RE =
  /\b[A-Z][a-zA-Z]+(?:Service|Module|Controller|Handler|Manager|Repository|Factory)\b/g;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function exportCommand(
  options: ExportOptions,
): Promise<{ kvCount: number; edgeCount: number }> {
  const { kvStore, graphStore, output, salt, raw } = options;
  const tokenMap = new Map<string, string>();

  // 1. Discover repos
  const repoNames = await discoverRepos(kvStore);

  // 2. Collect all data (async) before writing to destination
  const kvPairs: Array<[string, string]> = [];
  const commitByRepo = new Map<string, string>();
  const allKeys = await kvStore.keys();

  for (const key of allKeys) {
    if (!raw && SKIP_PREFIXES.some((p) => key.startsWith(p))) continue;

    const value = await kvStore.get(key);
    if (value === undefined) continue;

    if (key.startsWith("commit:")) {
      commitByRepo.set(key.slice("commit:".length), value);
    }

    if (raw) {
      kvPairs.push([key, value]);
    } else {
      const anonKey = anonymizeKey(key, repoNames, salt, tokenMap);
      let anonValue: string;

      if (key === "sarif:latest") {
        let sarif: SarifLog;
        try {
          sarif = JSON.parse(value) as SarifLog;
        } catch {
          continue; // Skip corrupted SARIF data
        }
        anonValue = JSON.stringify(
          redactSarifLog(sarif, {
            salt,
            redactFilePaths: true,
            preserveRuleIds: true,
            preserveStatistics: true,
          }),
        );
      } else {
        anonValue = anonymizeValue(value, repoNames, salt, tokenMap);
      }

      kvPairs.push([anonKey, anonValue]);
    }
  }

  // Collect edges
  interface EdgeRow {
    source: string;
    target: string;
    kind: string;
    metadata: string;
  }
  const edgeRows: EdgeRow[] = [];

  for (const kind of EDGE_KINDS) {
    for (const repo of repoNames) {
      const edges = await graphStore.getEdgesByKind(kind, repo);
      for (const edge of edges) {
        if (raw) {
          edgeRows.push({
            source: edge.source,
            target: edge.target,
            kind,
            metadata: edge.metadata ? JSON.stringify(edge.metadata) : "{}",
          });
        } else {
          const md: Record<string, unknown> = edge.metadata
            ? { ...edge.metadata }
            : {};
          if (typeof md.repo === "string") {
            md.repo = hashToken(md.repo, salt, tokenMap);
          }
          edgeRows.push({
            source: hashToken(edge.source, salt, tokenMap),
            target: hashToken(edge.target, salt, tokenMap),
            kind,
            metadata: JSON.stringify(md),
          });
        }
      }
    }
  }

  // 3. Create destination DB and write synchronously.
  // DROP + CREATE (not CREATE IF NOT EXISTS) so re-exports are always clean
  // rather than appending duplicates or leaving stale rows.
  const destDb = new Database(output);
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

  destDb.transaction(() => {
    for (const [key, value] of kvPairs) {
      insertKv.run(key, value);
    }
    for (const row of edgeRows) {
      insertEdge.run(row.source, row.target, row.kind, row.metadata);
    }

    // Write manifest
    const repoCommits: Array<{ name: string; commit: string }> = [];
    for (const repo of repoNames) {
      const repoName = raw ? repo : hashToken(repo, salt, tokenMap);
      repoCommits.push({ name: repoName, commit: commitByRepo.get(repo) ?? "" });
    }
    const manifest: ExportManifest = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      mode: raw ? "raw" : "anonymized",
      repos: repoCommits,
    };
    insertKv.run("mma:manifest", JSON.stringify(manifest));
  })();

  // 4. VACUUM and close
  destDb.exec("VACUUM");
  destDb.close();

  const kvCount = kvPairs.length + 1; // +1 for manifest
  const mode = raw ? "raw" : "anonymized";
  console.log(
    `Exported ${kvCount} KV entries and ${edgeRows.length} edges to ${output} (${mode})`,
  );
  return { kvCount, edgeCount: edgeRows.length };
}


// ---------------------------------------------------------------------------
// Anonymization helpers
// ---------------------------------------------------------------------------

function anonymizeKey(
  key: string,
  repoNames: string[],
  salt: string,
  tokenMap: Map<string, string>,
): string {
  // Sort longest-first so shorter names don't mask longer ones, and apply ALL
  // replacements rather than returning after the first match.
  const sorted = [...repoNames].sort((a, b) => b.length - a.length);
  let result = key;
  for (const repo of sorted) {
    if (result.includes(repo)) {
      result = result.replaceAll(repo, hashToken(repo, salt, tokenMap));
    }
  }
  return result;
}

function anonymizeValue(
  value: string,
  repoNames: string[],
  salt: string,
  tokenMap: Map<string, string>,
): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    const anonymized = walkAndAnonymize(parsed, repoNames, salt, tokenMap);
    return JSON.stringify(anonymized);
  } catch {
    return redactString(value, repoNames, salt, tokenMap);
  }
}

function walkAndAnonymize(
  obj: unknown,
  repoNames: string[],
  salt: string,
  tokenMap: Map<string, string>,
): unknown {
  if (typeof obj === "string") {
    return redactString(obj, repoNames, salt, tokenMap);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => walkAndAnonymize(item, repoNames, salt, tokenMap));
  }
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(
      obj as Record<string, unknown>,
    )) {
      result[key] = walkAndAnonymize(val, repoNames, salt, tokenMap);
    }
    return result;
  }
  return obj;
}

function redactString(
  text: string,
  repoNames: string[],
  salt: string,
  tokenMap: Map<string, string>,
): string {
  let result = text;

  // Replace repo names (longest first to avoid partial matches)
  const sorted = [...repoNames].sort((a, b) => b.length - a.length);
  for (const repo of sorted) {
    if (result.includes(repo)) {
      result = result.replaceAll(repo, hashToken(repo, salt, tokenMap));
    }
  }

  // Replace file paths
  result = result.replace(FILE_PATH_RE, (match) =>
    hashToken(match, salt, tokenMap),
  );

  // Replace service/module names (PascalCase + known suffixes)
  result = result.replace(SERVICE_NAME_RE, (match) =>
    hashToken(match, salt, tokenMap),
  );

  return result;
}
