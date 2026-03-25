/**
 * Kuzu-backed search store.
 *
 * Uses a SearchDoc node table with Kuzu's built-in FTS extension (BM25).
 * The FTS index must be dropped and recreated whenever documents change,
 * because Kuzu v0.11.3 does not support incremental FTS index updates.
 * A `ftsIndexDirty` flag defers the rebuild to the next search call.
 */

import type { SearchDocument, SearchResult, SearchStore } from "@mma/storage";
import kuzu from "kuzu";
import { single } from "./kuzu-common.js";

function sanitizeQuery(query: string): string {
  const tokens = query
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  return tokens.join(" ");
}

export class KuzuSearchStore implements SearchStore {
  private readonly conn: InstanceType<typeof kuzu.Connection>;
  private ftsIndexDirty: boolean = false;

  // Prepared once and reused across calls for efficiency.
  private readonly stmtUpsert: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtDeleteOne: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtDeleteByRepo: InstanceType<typeof kuzu.PreparedStatement>;

  // Cache of prepared FTS search statements keyed by "limit:repo" string.
  // Cleared whenever the FTS index is rebuilt (index change invalidates plans).
  private readonly stmtSearchCache = new Map<
    string,
    InstanceType<typeof kuzu.PreparedStatement>
  >();

  constructor(conn: InstanceType<typeof kuzu.Connection>) {
    this.conn = conn;

    this.stmtUpsert = conn.prepareSync(
      "MERGE (d:SearchDoc {id: $id}) SET d.content = $content, d.metadata = $meta, d.repo = $repo",
    );
    this.stmtDeleteOne = conn.prepareSync(
      "MATCH (d:SearchDoc) WHERE d.id = $id DELETE d",
    );
    this.stmtDeleteByRepo = conn.prepareSync(
      "MATCH (d:SearchDoc) WHERE d.repo = $r DELETE d",
    );
  }

  async index(documents: readonly SearchDocument[]): Promise<void> {
    for (const doc of documents) {
      const meta = JSON.stringify(doc.metadata);
      const repo = doc.metadata["repo"] ?? "";
      this.conn.executeSync(this.stmtUpsert, {
        id: doc.id,
        content: doc.content,
        meta,
        repo,
      });
    }
    // Fix 6: only mark dirty; do NOT eagerly rebuild. The rebuild is deferred
    // to the next search() call so that bulk indexing pays rebuild cost once.
    if (documents.length > 0) {
      this.ftsIndexDirty = true;
    }
  }

  async search(
    query: string,
    limit: number = 10,
    repo?: string,
  ): Promise<SearchResult[]> {
    const sanitized = sanitizeQuery(query);
    if (sanitized.length === 0) {
      return [];
    }

    if (this.ftsIndexDirty) {
      this.rebuildFtsIndex();
    }

    // Fix 7: cache prepared statements by (limit, repo) key to avoid
    // re-preparing on every call. Cache is cleared when the FTS index rebuilds.
    const cacheKey = `${limit}:${repo ?? ""}`;
    let stmt = this.stmtSearchCache.get(cacheKey);
    if (stmt === undefined) {
      // Fix 4: when repo is provided, push the filter into the Cypher WHERE
      // clause so filtering occurs in the database before LIMIT is applied.
      // Fix 5 (search): LIMIT does not accept parameters in Kuzu; interpolate
      // the number directly. `limit` is always a number, so this is safe.
      const repoFilter =
        repo !== undefined ? ` AND node.repo = "${repo.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : "";
      const cypher =
        `CALL QUERY_FTS_INDEX("SearchDoc", "search_idx", $q, conjunctive := false)` +
        ` WHERE score > 0${repoFilter}` +
        ` RETURN node.id AS id, node.content AS content, node.metadata AS metadata, node.repo AS repo, score` +
        ` LIMIT ${limit}`;
      stmt = this.conn.prepareSync(cypher);
      this.stmtSearchCache.set(cacheKey, stmt);
    }

    const result = this.conn.executeSync(stmt, { q: sanitized });
    const rows = single(result).getAllSync();

    const results: SearchResult[] = [];
    for (const row of rows) {
      let metadata: Record<string, string> = {};
      const rawMeta = row["metadata"] as string;
      try {
        metadata = JSON.parse(rawMeta) as Record<string, string>;
      } catch {
        // Malformed metadata; fall back to empty object.
      }

      results.push({
        id: row["id"] as string,
        score: row["score"] as number,
        content: row["content"] as string,
        metadata,
      });
    }

    return results;
  }

  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.conn.executeSync(this.stmtDeleteOne, { id });
    }
    if (ids.length > 0) {
      this.ftsIndexDirty = true;
    }
  }

  async deleteByFilePaths(repo: string, filePaths: readonly string[]): Promise<void> {
    if (filePaths.length === 0) return;
    let deleted = 0;
    for (const fp of filePaths) {
      // Match exact file path ID or entity IDs prefixed with "fp#"
      const prefix = fp + '#';
      const result = this.conn.querySync(
        `MATCH (d:SearchDoc) WHERE d.repo = "${repo.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        + ` AND (d.id = "${fp.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        + ` OR STARTS_WITH(d.id, "${prefix.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")) DELETE d RETURN count(*) AS n`,
      );
      const rows = single(result).getAllSync();
      deleted += (rows[0]?.["n"] as number | undefined) ?? 0;
    }
    if (deleted > 0) {
      this.ftsIndexDirty = true;
    }
  }

  async clear(repo?: string): Promise<void> {
    if (repo !== undefined) {
      this.conn.executeSync(this.stmtDeleteByRepo, { r: repo });
    } else {
      this.conn.querySync("MATCH (d:SearchDoc) DELETE d");
    }
    this.ftsIndexDirty = true;
  }

  async close(): Promise<void> {
    // No-op: connection lifecycle is managed externally.
  }

  private rebuildFtsIndex(): void {
    try {
      this.conn.querySync(`CALL DROP_FTS_INDEX("SearchDoc", "search_idx")`);
    } catch {
      // Index may not exist yet (first run); ignore.
    }
    this.conn.querySync(
      `CALL CREATE_FTS_INDEX("SearchDoc", "search_idx", ["content"])`,
    );
    this.ftsIndexDirty = false;
    // Fix 7: clear the statement cache — plans prepared against the old index
    // are invalid after the index is rebuilt.
    this.stmtSearchCache.clear();
  }
}
