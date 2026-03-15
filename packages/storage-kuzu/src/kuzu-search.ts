/**
 * Kuzu-backed search store.
 *
 * Uses a SearchDoc node table with Kuzu's built-in FTS extension (BM25).
 * The FTS index must be dropped and recreated whenever documents change,
 * because Kuzu v0.11.3 does not support incremental FTS index updates.
 * A `ftsIndexDirty` flag defers the rebuild to the next search call but
 * we eagerly rebuild after mutations so that concurrent reads remain valid.
 */

import type { SearchDocument, SearchResult, SearchStore } from "@mma/storage";
import kuzu from "kuzu";

/** Normalize executeSync's union return to a single QueryResult. */
function single(
  result: kuzu.QueryResult | kuzu.QueryResult[],
): kuzu.QueryResult {
  return Array.isArray(result) ? (result[0] as kuzu.QueryResult) : result;
}

function sanitizeQuery(query: string): string {
  const tokens = query
    .replace(/[^\w\s]/g, " ")
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
    if (documents.length > 0) {
      this.ftsIndexDirty = true;
      this.rebuildFtsIndex();
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

    // LIMIT does not accept parameters in Kuzu; interpolate the number directly.
    // `limit` is always a number (type-enforced), so this is safe.
    const cypher = `CALL QUERY_FTS_INDEX("SearchDoc", "search_idx", $q, conjunctive := false) RETURN node.id AS id, node.content AS content, node.metadata AS metadata, node.repo AS repo, score LIMIT ${limit}`;
    const stmt = this.conn.prepareSync(cypher);
    const result = this.conn.executeSync(stmt, { q: sanitized });
    const rows = single(result).getAllSync();

    const results: SearchResult[] = [];
    for (const row of rows) {
      const rowRepo = row["repo"] as string;
      if (repo !== undefined && rowRepo !== repo) {
        continue;
      }

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
      this.rebuildFtsIndex();
    }
  }

  async clear(repo?: string): Promise<void> {
    if (repo !== undefined) {
      this.conn.executeSync(this.stmtDeleteByRepo, { r: repo });
    } else {
      this.conn.querySync("MATCH (d:SearchDoc) DELETE d");
    }
    this.ftsIndexDirty = true;
    this.rebuildFtsIndex();
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
  }
}
