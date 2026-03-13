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
import { hashToken, redactSarifLog } from "@mma/diagnostics";

export interface ExportOptions {
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly output: string;
  readonly salt: string;
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
  const { kvStore, graphStore, output, salt } = options;
  const tokenMap = new Map<string, string>();

  // 1. Discover repos
  const repoNames = await discoverRepos(kvStore);

  // 2. Collect all data (async) before writing to destination
  const kvPairs: Array<[string, string]> = [];
  const allKeys = await kvStore.keys();

  for (const key of allKeys) {
    if (SKIP_PREFIXES.some((p) => key.startsWith(p))) continue;

    const value = await kvStore.get(key);
    if (value === undefined) continue;

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

  // 3. Create destination DB and write synchronously
  const destDb = new Database(output);
  destDb.pragma("journal_mode = WAL");
  destDb.exec(`
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges (source);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges (target);
    CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges (kind);
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
  })();

  // 4. VACUUM and close
  destDb.exec("VACUUM");
  destDb.close();

  console.log(
    `Exported ${kvPairs.length} KV entries and ${edgeRows.length} edges to ${output}`,
  );
  return { kvCount: kvPairs.length, edgeCount: edgeRows.length };
}

// ---------------------------------------------------------------------------
// Repo discovery (same logic as report-cmd)
// ---------------------------------------------------------------------------

async function discoverRepos(kvStore: KVStore): Promise<string[]> {
  const repoSet = new Set<string>();

  const prefixes = [
    "metricsSummary:",
    "metrics:",
    "patterns:",
    "sarif:deadExports:",
  ];
  for (const prefix of prefixes) {
    const keys = await kvStore.keys(prefix);
    for (const key of keys) {
      const repoName = key.slice(prefix.length);
      if (repoName && !repoName.includes(":")) {
        repoSet.add(repoName);
      }
    }
  }

  const commitKeys = await kvStore.keys("commit:");
  for (const key of commitKeys) {
    const repoName = key.slice("commit:".length);
    if (repoName) repoSet.add(repoName);
  }

  return [...repoSet].sort();
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
  for (const repo of repoNames) {
    if (key.includes(repo)) {
      return key.replaceAll(repo, hashToken(repo, salt, tokenMap));
    }
  }
  return key;
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
