/**
 * SQLite-backed search store using FTS5 with BM25 ranking.
 *
 * FTS5 bm25() returns negative scores (lower = better match).
 * We negate them so higher = better match, consistent with the interface contract.
 *
 * Query tokens are individually quoted to prevent FTS5 syntax injection.
 */

import type Database from "better-sqlite3";
import type { SearchDocument, SearchResult, SearchStore } from "./search.js";

export class SqliteSearchStore implements SearchStore {
  private readonly stmtInsertDoc: Database.Statement;
  private readonly stmtInsertFts: Database.Statement;
  private readonly stmtDeleteDoc: Database.Statement;
  private readonly stmtDeleteFts: Database.Statement;
  private readonly stmtSearch: Database.Statement;
  private readonly stmtSearchByRepo: Database.Statement;
  private readonly stmtClearDocs: Database.Statement;
  private readonly stmtClearFts: Database.Statement;
  private readonly stmtFindByRepo: Database.Statement;

  private readonly insertManyTx: Database.Transaction<
    (docs: readonly SearchDocument[]) => void
  >;
  private readonly deleteManyTx: Database.Transaction<
    (ids: readonly string[]) => void
  >;

  constructor(db: Database.Database) {
    this.stmtInsertDoc = db.prepare(
      "INSERT OR REPLACE INTO search_docs (id, content, metadata) VALUES (?, ?, ?)",
    );
    this.stmtInsertFts = db.prepare(
      "INSERT OR REPLACE INTO search_fts (id, content) VALUES (?, ?)",
    );
    this.stmtDeleteDoc = db.prepare("DELETE FROM search_docs WHERE id = ?");
    this.stmtDeleteFts = db.prepare(
      "DELETE FROM search_fts WHERE id = ?",
    );
    this.stmtSearch = db.prepare(`
      SELECT f.id, f.content, d.metadata, bm25(search_fts) AS score
      FROM search_fts f
      JOIN search_docs d ON d.id = f.id
      WHERE search_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `);
    this.stmtSearchByRepo = db.prepare(`
      SELECT f.id, f.content, d.metadata, bm25(search_fts) AS score
      FROM search_fts f
      JOIN search_docs d ON d.id = f.id
      WHERE search_fts MATCH ?
        AND json_extract(d.metadata, '$.repo') = ?
      ORDER BY score
      LIMIT ?
    `);
    this.stmtClearDocs = db.prepare("DELETE FROM search_docs");
    this.stmtClearFts = db.prepare("DELETE FROM search_fts");
    this.stmtFindByRepo = db.prepare(
      "SELECT id FROM search_docs WHERE json_extract(metadata, '$.repo') = ?",
    );

    this.insertManyTx = db.transaction((docs: readonly SearchDocument[]) => {
      for (const doc of docs) {
        // Delete old FTS entry first to avoid stale tokens
        this.stmtDeleteFts.run(doc.id);
        const meta = JSON.stringify(doc.metadata);
        this.stmtInsertDoc.run(doc.id, doc.content, meta);
        this.stmtInsertFts.run(doc.id, doc.content);
      }
    });

    this.deleteManyTx = db.transaction((ids: readonly string[]) => {
      for (const id of ids) {
        this.stmtDeleteDoc.run(id);
        this.stmtDeleteFts.run(id);
      }
    });
  }

  async index(documents: readonly SearchDocument[]): Promise<void> {
    if (documents.length === 0) return;
    this.insertManyTx(documents);
  }

  async search(query: string, limit: number = 10, repo?: string): Promise<SearchResult[]> {
    const ftsQuery = sanitizeQuery(query);
    if (!ftsQuery) return [];

    const rows = (repo
      ? this.stmtSearchByRepo.all(ftsQuery, repo, limit)
      : this.stmtSearch.all(ftsQuery, limit)
    ) as Array<{
      id: string;
      content: string;
      metadata: string;
      score: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      metadata: (() => { try { return JSON.parse(row.metadata) as Record<string, string>; } catch { return {} as Record<string, string>; } })(),
      score: -row.score, // bm25() returns negative; negate for positive
    }));
  }

  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    this.deleteManyTx(ids);
  }

  async clear(repo?: string): Promise<void> {
    if (repo) {
      const rows = this.stmtFindByRepo.all(repo) as Array<{ id: string }>;
      if (rows.length > 0) {
        await this.delete(rows.map((r) => r.id));
      }
      return;
    }
    this.stmtClearFts.run();
    this.stmtClearDocs.run();
  }

  async close(): Promise<void> {
    // No-op: lifecycle managed by createSqliteStores()
  }
}

/**
 * Sanitize a user query for FTS5.
 * Each token is double-quoted to prevent syntax injection, then OR-joined.
 */
function sanitizeQuery(query: string): string {
  const tokens = query
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
