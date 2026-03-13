/**
 * Document search store adapter.
 *
 * POC: In-memory BM25 implementation.
 * Scale: MeiliSearch (single binary) -> Elasticsearch cluster.
 *
 * Stores: code summaries, descriptions, log templates for BM25 search.
 */

export interface SearchDocument {
  readonly id: string;
  readonly content: string;
  readonly metadata: Record<string, string>;
}

export interface SearchResult {
  readonly id: string;
  readonly score: number;
  readonly content: string;
  readonly metadata: Record<string, string>;
}

export interface SearchStore {
  index(documents: readonly SearchDocument[]): Promise<void>;
  search(query: string, limit?: number, repo?: string): Promise<SearchResult[]>;
  delete(ids: readonly string[]): Promise<void>;
  clear(repo?: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * In-memory BM25 search for POC.
 * Replace with MeiliSearch adapter for persistent POC, Elasticsearch for scale.
 */
export class InMemorySearchStore implements SearchStore {
  private documents = new Map<string, SearchDocument>();
  private invertedIndex = new Map<string, Set<string>>();
  private docLengths = new Map<string, number>();
  private avgDocLength = 0;

  // BM25 parameters
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  async index(documents: readonly SearchDocument[]): Promise<void> {
    for (const doc of documents) {
      // Remove old inverted index entries before re-indexing
      const existing = this.documents.get(doc.id);
      if (existing) {
        const oldTokens = tokenize(existing.content);
        for (const token of oldTokens) {
          this.invertedIndex.get(token)?.delete(doc.id);
        }
      }

      this.documents.set(doc.id, doc);
      const tokens = tokenize(doc.content);
      this.docLengths.set(doc.id, tokens.length);

      for (const token of tokens) {
        const posting = this.invertedIndex.get(token) ?? new Set();
        posting.add(doc.id);
        this.invertedIndex.set(token, posting);
      }
    }

    this.updateAvgDocLength();
  }

  async search(query: string, limit: number = 10, repo?: string): Promise<SearchResult[]> {
    const queryTokens = tokenize(query);
    const scores = new Map<string, number>();

    for (const token of queryTokens) {
      const postings = this.invertedIndex.get(token);
      if (!postings) continue;

      const idf = this.computeIDF(postings.size);

      for (const docId of postings) {
        // Skip documents from other repos when repo filter is active
        if (repo) {
          const doc = this.documents.get(docId);
          if (doc && doc.metadata.repo !== repo) continue;
        }

        const docLength = this.docLengths.get(docId) ?? 0;
        const tf = this.computeTF(token, docId);
        const score = this.bm25Score(tf, idf, docLength);

        scores.set(docId, (scores.get(docId) ?? 0) + score);
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => {
        const doc = this.documents.get(id)!;
        return {
          id,
          score,
          content: doc.content,
          metadata: doc.metadata,
        };
      });
  }

  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const doc = this.documents.get(id);
      if (!doc) continue;

      const tokens = tokenize(doc.content);
      for (const token of tokens) {
        this.invertedIndex.get(token)?.delete(id);
      }
      this.documents.delete(id);
      this.docLengths.delete(id);
    }
    this.updateAvgDocLength();
  }

  async clear(repo?: string): Promise<void> {
    if (repo) {
      const idsToRemove: string[] = [];
      for (const [id, doc] of this.documents) {
        if (doc.metadata.repo === repo) {
          idsToRemove.push(id);
        }
      }
      await this.delete(idsToRemove);
      return;
    }
    this.documents.clear();
    this.invertedIndex.clear();
    this.docLengths.clear();
    this.avgDocLength = 0;
  }

  async close(): Promise<void> {
    await this.clear();
  }

  private computeIDF(docFreq: number): number {
    const N = this.documents.size;
    return Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
  }

  private computeTF(token: string, docId: string): number {
    const doc = this.documents.get(docId);
    if (!doc) return 0;
    const tokens = tokenize(doc.content);
    return tokens.filter((t) => t === token).length;
  }

  private bm25Score(tf: number, idf: number, docLength: number): number {
    const numerator = tf * (this.k1 + 1);
    const denominator =
      tf + this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength));
    return idf * (numerator / denominator);
  }

  private updateAvgDocLength(): void {
    if (this.docLengths.size === 0) {
      this.avgDocLength = 0;
      return;
    }
    let total = 0;
    for (const len of this.docLengths.values()) {
      total += len;
    }
    this.avgDocLength = total / this.docLengths.size;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}
