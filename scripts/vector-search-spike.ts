/**
 * Vector search evaluation spike.
 *
 * Compares BM25 (SQLite FTS5) vs cosine-similarity vector search using
 * Ollama nomic-embed-text embeddings against the NestJS test corpus.
 *
 * Usage:
 *   npx tsx scripts/vector-search-spike.ts
 *   npx tsx scripts/vector-search-spike.ts --embed-only
 *
 * Prerequisites:
 *   - data/mma.db exists and has been indexed
 *   - Ollama running at http://localhost:11434 with nomic-embed-text pulled
 */

// ESM script — not part of the build, not imported anywhere.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import DatabaseCtor from "better-sqlite3";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DB_PATH = resolve(import.meta.dirname, "../data/mma.db");
const CACHE_PATH = "/tmp/mma-vector-spike-embeddings.json";
const OLLAMA_URL = "http://localhost:11434/api/embed";
const EMBED_MODEL = "nomic-embed-text";
const EMBED_BATCH = 100;
const BM25_GROUND_TRUTH_LIMIT = 50;
const EVAL_K = 10;

const EMBED_ONLY = process.argv.includes("--embed-only");

// ---------------------------------------------------------------------------
// Query set (~25 queries across structural/semantic/cross-cutting categories)
// ---------------------------------------------------------------------------

const QUERIES: string[] = [
  // Structural / exact
  "UserService",
  "AuthGuard",
  "ConfigModule",
  "Logger",
  "HttpException",
  // Semantic / fuzzy
  "authentication middleware",
  "database connection pooling",
  "error handling",
  "dependency injection container",
  "request validation",
  "event handling",
  "caching strategy",
  "middleware pipeline",
  "module initialization",
  "service registry",
  // Cross-cutting
  "health check endpoint",
  "rate limiting",
  "logging configuration",
  "environment variables",
  "testing utilities",
  // Additional structural
  "TypeOrmModule",
  "JwtService",
  "NotFoundException",
  "interceptor",
  "pipe validation",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DocRow {
  id: string;
  content: string;
  metadata: string;
}

interface SearchRow {
  id: string;
  content: string;
  metadata: string;
  score: number;
}

interface EmbeddingCache {
  model: string;
  docIds: string[];
  docEmbeddings: number[][];
  queryEmbeddings: Record<string, number[]>;
}

interface QueryResult {
  query: string;
  bm25Hits: string[];
  vectorHits: string[];
  groundTruth: string[]; // BM25 top-50 ids
  overlap: number;        // |bm25@10 ∩ vector@10|
  bm25Precision: number;  // |bm25@10 ∩ ground_truth| / 10
  vectorPrecision: number;// |vector@10 ∩ ground_truth| / 10
  vectorOnly: string[];   // in vector@10 but not bm25@10 (novel)
}

// ---------------------------------------------------------------------------
// Timing helper
// ---------------------------------------------------------------------------

function timer(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}

// ---------------------------------------------------------------------------
// BM25 search via raw SQLite
// ---------------------------------------------------------------------------

function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

function bm25Search(
  db: ReturnType<typeof DatabaseCtor>,
  query: string,
  limit: number,
): SearchRow[] {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];
  const stmt = db.prepare<[string, number], SearchRow>(`
    SELECT f.id, f.content, d.metadata, bm25(search_fts) AS score
    FROM search_fts f
    JOIN search_docs d ON d.id = f.id
    WHERE search_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `);
  return stmt.all(ftsQuery, limit);
}

// ---------------------------------------------------------------------------
// Ollama embedding
// ---------------------------------------------------------------------------

async function ollamaEmbed(texts: string[]): Promise<number[][]> {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`Ollama returned HTTP ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { embeddings: number[][] };
  if (!Array.isArray(json.embeddings)) {
    throw new Error(`Unexpected Ollama response shape: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.embeddings;
}

async function embedInBatches(texts: string[]): Promise<number[][]> {
  const result: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const vecs = await ollamaEmbed(batch);
    result.push(...vecs);
    process.stdout.write(`\r  embedding batch ${Math.ceil((i + EMBED_BATCH) / EMBED_BATCH)}/${Math.ceil(texts.length / EMBED_BATCH)}   `);
  }
  process.stdout.write("\n");
  return result;
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function vectorSearch(
  queryVec: number[],
  docIds: string[],
  docEmbeddings: number[][],
  k: number,
): string[] {
  const scores = docIds.map((id, i) => ({ id, score: cosine(queryVec, docEmbeddings[i]) }));
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k).map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // --- Open DB ---
  if (!existsSync(DB_PATH)) {
    console.error(`ERROR: DB not found at ${DB_PATH}`);
    console.error("Run: node apps/cli/dist/index.js index -c mma.config.json -v");
    process.exit(1);
  }
  const db = new DatabaseCtor(DB_PATH, { readonly: true });

  const countRow = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM search_docs").get();
  const docCount = countRow?.n ?? 0;
  if (docCount === 0) {
    console.error("ERROR: search_docs table is empty. Has the DB been indexed?");
    process.exit(1);
  }
  console.log(`Opened ${DB_PATH} — ${docCount} search documents`);

  // --- Load all docs for embedding ---
  const t0 = timer();
  const allDocs = db
    .prepare<[], DocRow>("SELECT id, content, metadata FROM search_docs")
    .all();
  console.log(`Loaded ${allDocs.length} docs in ${t0()}ms`);

  const docIds = allDocs.map((d) => d.id);
  const docContents = allDocs.map((d) => d.content);

  // --- Load or build embedding cache ---
  let cache: EmbeddingCache | null = null;

  if (existsSync(CACHE_PATH)) {
    try {
      cache = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as EmbeddingCache;
      if (cache.model !== EMBED_MODEL || cache.docIds.length !== docIds.length) {
        console.log("Cache model/size mismatch — regenerating.");
        cache = null;
      } else {
        console.log(`Loaded embedding cache from ${CACHE_PATH}`);
      }
    } catch {
      console.log("Cache parse error — regenerating.");
      cache = null;
    }
  }

  // Check Ollama is reachable before doing expensive work
  let ollamaOk = true;
  try {
    const ping = await fetch("http://localhost:11434/api/tags");
    if (!ping.ok) ollamaOk = false;
  } catch {
    ollamaOk = false;
  }

  if (!ollamaOk) {
    console.error("ERROR: Ollama is not reachable at http://localhost:11434");
    console.error("Start Ollama and ensure nomic-embed-text is pulled:");
    console.error("  ollama pull nomic-embed-text");
    process.exit(1);
  }

  if (!cache) {
    console.log(`Generating doc embeddings via Ollama ${EMBED_MODEL} (${allDocs.length} docs)...`);
    const te = timer();
    const docEmbeddings = await embedInBatches(docContents);
    console.log(`Doc embeddings generated in ${te()}ms`);

    console.log("Generating query embeddings...");
    const tq = timer();
    const queryVecs = await ollamaEmbed(QUERIES);
    console.log(`Query embeddings generated in ${tq()}ms`);

    const queryEmbeddings: Record<string, number[]> = {};
    QUERIES.forEach((q, i) => { queryEmbeddings[q] = queryVecs[i]; });

    cache = { model: EMBED_MODEL, docIds, docEmbeddings, queryEmbeddings };
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
    console.log(`Embeddings cached to ${CACHE_PATH}`);
  } else {
    // Ensure all queries have embeddings; fetch missing ones
    const missing = QUERIES.filter((q) => !cache!.queryEmbeddings[q]);
    if (missing.length > 0) {
      console.log(`Fetching ${missing.length} new query embeddings...`);
      const vecs = await ollamaEmbed(missing);
      missing.forEach((q, i) => { cache!.queryEmbeddings[q] = vecs[i]; });
      writeFileSync(CACHE_PATH, JSON.stringify(cache));
    }
  }

  if (EMBED_ONLY) {
    console.log("--embed-only: done. Exiting.");
    db.close();
    return;
  }

  // --- Evaluation ---
  console.log("\n=== Evaluation ===\n");
  const results: QueryResult[] = [];

  for (const query of QUERIES) {
    // BM25 ground truth (top-50) and BM25@10
    const tb = timer();
    const gt50 = bm25Search(db, query, BM25_GROUND_TRUTH_LIMIT);
    const bm25Time = tb();
    const groundTruth = gt50.map((r) => r.id);
    const bm25Hits = groundTruth.slice(0, EVAL_K);

    // Vector@10
    const tv = timer();
    const queryVec = cache.queryEmbeddings[query];
    const vectorHits = vectorSearch(queryVec, cache.docIds, cache.docEmbeddings, EVAL_K);
    const vectorTime = tv();

    const gtSet = new Set(groundTruth);
    const bm25Set = new Set(bm25Hits);
    const vectorSet = new Set(vectorHits);

    const overlap = [...bm25Set].filter((id) => vectorSet.has(id)).length;
    const bm25Precision = bm25Hits.filter((id) => gtSet.has(id)).length / EVAL_K;
    const vectorPrecision = vectorHits.filter((id) => gtSet.has(id)).length / EVAL_K;
    const vectorOnly = vectorHits.filter((id) => !bm25Set.has(id));

    results.push({ query, bm25Hits, vectorHits, groundTruth, overlap, bm25Precision, vectorPrecision, vectorOnly });

    const flag = vectorPrecision > bm25Precision ? " +" : vectorPrecision < bm25Precision ? " -" : "  ";
    console.log(
      `[${flag}] "${query.padEnd(32)}"` +
      `  BM25 P@10=${bm25Precision.toFixed(2)}` +
      `  Vec P@10=${vectorPrecision.toFixed(2)}` +
      `  overlap=${overlap}` +
      `  novel=${vectorOnly.length}` +
      `  (bm25 ${bm25Time}ms, vec ${vectorTime}ms)`,
    );
  }

  // --- Aggregate ---
  const avgBm25P = results.reduce((s, r) => s + r.bm25Precision, 0) / results.length;
  const avgVecP  = results.reduce((s, r) => s + r.vectorPrecision, 0) / results.length;
  const avgOverlap = results.reduce((s, r) => s + r.overlap, 0) / results.length;
  const vecWins  = results.filter((r) => r.vectorPrecision > r.bm25Precision).length;
  const bm25Wins = results.filter((r) => r.bm25Precision  > r.vectorPrecision).length;
  const ties     = results.length - vecWins - bm25Wins;

  console.log(`
=== Aggregate (${results.length} queries, K=${EVAL_K}, ground truth = BM25 top-${BM25_GROUND_TRUTH_LIMIT}) ===

  avg BM25 P@${EVAL_K}  : ${avgBm25P.toFixed(3)}
  avg Vec  P@${EVAL_K}  : ${avgVecP.toFixed(3)}
  avg overlap@${EVAL_K} : ${avgOverlap.toFixed(2)}
  vector wins          : ${vecWins}
  BM25 wins            : ${bm25Wins}
  ties                 : ${ties}

NOTE: Ground truth is BM25 top-50, so this inherently favours BM25.
      "vector wins" indicates queries where vector finds GT results BM25 top-10 misses.
      Review "novel" results manually for semantic relevance.
`);

  // --- Novel discoveries spot-check ---
  const queryWithNovel = results
    .filter((r) => r.vectorOnly.length > 0)
    .sort((a, b) => b.vectorOnly.length - a.vectorOnly.length)
    .slice(0, 5);

  if (queryWithNovel.length > 0) {
    console.log("=== Top novel vector discoveries (vector@10 not in BM25@10) ===\n");
    for (const r of queryWithNovel) {
      console.log(`  Query: "${r.query}" — ${r.vectorOnly.length} novel result(s)`);
      for (const id of r.vectorOnly.slice(0, 3)) {
        const row = db.prepare<[string], DocRow>("SELECT content FROM search_docs WHERE id = ?").get(id);
        const snippet = (row?.content ?? "").replace(/\s+/g, " ").slice(0, 120);
        console.log(`    id: ${id}`);
        console.log(`    -> ${snippet}`);
      }
      console.log();
    }
  }

  db.close();
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
