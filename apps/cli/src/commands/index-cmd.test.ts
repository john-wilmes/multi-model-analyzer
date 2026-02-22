/**
 * Integration tests for indexCommand: validates incremental indexing behavior.
 *
 * Mocks external packages (ingestion, parsing, structural, heuristics,
 * summarization, models) and uses InMemory stores for real store behavior.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  ChangeSet,
  ParsedFile,
  ClassifiedFile,
  GraphEdge,
  DependencyGraph,
} from "@mma/core";
import {
  InMemoryGraphStore,
  InMemorySearchStore,
  InMemoryKVStore,
} from "@mma/storage";
import { indexCommand, type IndexOptions } from "./index-cmd.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("{}"),
}));

vi.mock("@mma/ingestion", () => ({
  detectChanges: vi.fn(),
  classifyFiles: vi.fn().mockReturnValue([]),
}));

vi.mock("@mma/parsing", () => ({
  parseFiles: vi.fn(),
}));

vi.mock("@mma/structural", () => ({
  extractDependencyGraph: vi.fn(),
  buildControlFlowGraph: vi.fn(),
  createCfgIdCounter: vi.fn().mockReturnValue({ next: () => 0 }),
  extractCallEdgesFromTreeSitter: vi.fn().mockReturnValue([]),
}));

vi.mock("@mma/heuristics", () => ({
  inferServices: vi.fn().mockReturnValue([]),
  detectPatterns: vi.fn().mockReturnValue([]),
  scanForFlags: vi.fn().mockReturnValue({ flags: [] }),
  extractLogStatements: vi.fn().mockReturnValue({ repo: "", templates: [] }),
  analyzeNaming: vi.fn().mockReturnValue({ methods: [] }),
  extractServiceTopology: vi.fn().mockReturnValue([]),
}));

vi.mock("@mma/summarization", () => ({
  tier1Summarize: vi.fn().mockReturnValue([]),
  tier2Summarize: vi.fn().mockReturnValue([]),
  tier4BatchSummarize: vi.fn().mockResolvedValue([]),
  SONNET_DEFAULTS: {},
}));

vi.mock("@mma/model-config", () => ({
  buildFeatureModel: vi.fn(),
  extractConstraintsFromCode: vi.fn().mockReturnValue([]),
  validateFeatureModel: vi
    .fn()
    .mockResolvedValue({ results: [], validation: { deadFlags: [], alwaysOnFlags: [], untestedInteractions: [] } }),
}));

vi.mock("@mma/model-fault", () => ({
  identifyLogRoots: vi.fn().mockReturnValue([]),
  traceBackwardFromLog: vi.fn().mockReturnValue({ steps: [] }),
  buildFaultTree: vi.fn(),
  analyzeGaps: vi.fn().mockReturnValue([]),
}));

vi.mock("@mma/model-functional", () => ({
  buildServiceCatalog: vi.fn().mockReturnValue([]),
  generateDocumentation: vi.fn().mockReturnValue(""),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChangeSet(overrides: Partial<ChangeSet> & { repo: string; commitHash: string }): ChangeSet {
  return {
    previousCommitHash: null,
    addedFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    timestamp: new Date(),
    ...overrides,
  };
}

function makeClassified(path: string, repo: string): ClassifiedFile {
  return { path, repo, kind: "typescript", relativePath: path };
}

function makeParsedFile(path: string, repo: string): ParsedFile {
  return {
    path,
    repo,
    kind: "typescript",
    symbols: [],
    contentHash: "abc123",
    errors: [],
  };
}

const fakeTreeDelete = vi.fn();
function makeFakeTree() {
  return { rootNode: { namedChildren: [], type: "program" }, delete: fakeTreeDelete };
}

function makeParseResult(parsedFiles: ParsedFile[], treeFiles: string[] = []) {
  const treeSitterTrees = new Map<string, ReturnType<typeof makeFakeTree>>();
  for (const f of treeFiles) {
    treeSitterTrees.set(f, makeFakeTree());
  }
  return {
    parsedFiles,
    treeSitterTrees,
    stats: {
      fileCount: parsedFiles.length,
      symbolCount: 0,
      errorCount: 0,
      treeSitterTimeMs: 0,
      tsMorphTimeMs: 0,
    },
  };
}

const emptyDepGraph: DependencyGraph = {
  repo: "",
  edges: [],
  circularDependencies: [],
};

function makeOptions(
  repos: IndexOptions["repos"],
  stores: { kvStore: InMemoryKVStore; graphStore: InMemoryGraphStore; searchStore: InMemorySearchStore },
): IndexOptions {
  return {
    repos,
    mirrorDir: "/tmp/mirrors",
    kvStore: stores.kvStore,
    graphStore: stores.graphStore,
    searchStore: stores.searchStore,
    verbose: false,
  };
}

// ---------------------------------------------------------------------------
// Import mocked modules for per-test configuration
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { detectChanges, classifyFiles } from "@mma/ingestion";
import { parseFiles } from "@mma/parsing";
import { extractDependencyGraph } from "@mma/structural";
import { tier1Summarize } from "@mma/summarization";

const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockDetectChanges = detectChanges as ReturnType<typeof vi.fn>;
const mockClassifyFiles = classifyFiles as ReturnType<typeof vi.fn>;
const mockParseFiles = parseFiles as ReturnType<typeof vi.fn>;
const mockExtractDepGraph = extractDependencyGraph as ReturnType<typeof vi.fn>;
const mockTier1Summarize = tier1Summarize as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("indexCommand", () => {
  let kvStore: InMemoryKVStore;
  let graphStore: InMemoryGraphStore;
  let searchStore: InMemorySearchStore;

  const repoA = { name: "repo-a", url: "https://example.com/a.git", branch: "main", localPath: "/tmp/mirrors/repo-a" };
  const repoB = { name: "repo-b", url: "https://example.com/b.git", branch: "main", localPath: "/tmp/mirrors/repo-b" };

  beforeEach(() => {
    vi.clearAllMocks();
    kvStore = new InMemoryKVStore();
    graphStore = new InMemoryGraphStore();
    searchStore = new InMemorySearchStore();
    fakeTreeDelete.mockReset();
  });

  // -----------------------------------------------------------------------
  // Test 1: Unchanged repo (same commit hash) -- no store mutations
  // -----------------------------------------------------------------------
  it("skips processing when repo has no changed files", async () => {
    // Seed the previous commit hash
    await kvStore.set("commit:repo-a", "abc111");

    // detectChanges returns empty adds/mods/deletes
    mockDetectChanges.mockResolvedValue(
      makeChangeSet({ repo: "repo-a", commitHash: "abc111", previousCommitHash: "abc111" }),
    );
    // classifyFiles returns empty (no files to process)
    mockClassifyFiles.mockReturnValue([]);

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    // parseFiles should never be called (no classified files)
    expect(mockParseFiles).not.toHaveBeenCalled();

    // Commit hash should remain the original value (no update since no parsedFiles)
    const commitHash = await kvStore.get("commit:repo-a");
    expect(commitHash).toBe("abc111");

    // Graph store should have no edges
    const edges = await graphStore.getEdgesFrom("any-source");
    expect(edges).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test 2: Changed repo -- full pipeline processes, stores updated
  // -----------------------------------------------------------------------
  it("processes changed files and updates stores", async () => {
    const changeSet = makeChangeSet({
      repo: "repo-a",
      commitHash: "def222",
      addedFiles: ["src/index.ts", "src/utils.ts"],
    });
    mockDetectChanges.mockResolvedValue(changeSet);

    const classified = [
      makeClassified("src/index.ts", "repo-a"),
      makeClassified("src/utils.ts", "repo-a"),
    ];
    mockClassifyFiles.mockReturnValue(classified);

    const parsedFiles = [
      makeParsedFile("src/index.ts", "repo-a"),
      makeParsedFile("src/utils.ts", "repo-a"),
    ];
    mockParseFiles.mockResolvedValue(makeParseResult(parsedFiles, ["src/index.ts", "src/utils.ts"]));

    const depEdge: GraphEdge = {
      source: "src/index.ts",
      target: "src/utils.ts",
      kind: "imports",
      metadata: { repo: "repo-a" },
    };
    mockExtractDepGraph.mockReturnValue({
      ...emptyDepGraph,
      repo: "repo-a",
      edges: [depEdge],
    });

    mockTier1Summarize.mockReturnValue([
      { entityId: "src/index.ts#main", description: "main entry", tier: 1, confidence: 0.8 },
    ]);

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    // parseFiles called with the classified files
    expect(mockParseFiles).toHaveBeenCalledOnce();

    // Graph store should have the import edge (added by extractDependencyGraph path)
    const edges = await graphStore.getEdgesFrom("src/index.ts");
    expect(edges.some((e: GraphEdge) => e.target === "src/utils.ts" && e.kind === "imports")).toBe(true);

    // Search store should have indexed summaries
    const searchResults = await searchStore.search("main entry");
    expect(searchResults.length).toBeGreaterThan(0);

    // Commit hash updated to new value
    const commitHash = await kvStore.get("commit:repo-a");
    expect(commitHash).toBe("def222");
  });

  // -----------------------------------------------------------------------
  // Test 3: Deleted files -- stale data cleaned up
  // -----------------------------------------------------------------------
  it("cleans up stale data for deleted files", async () => {
    // Pre-populate stores with data for the file that will be deleted
    await graphStore.addEdges([
      { source: "src/old.ts", target: "src/dep.ts", kind: "imports", metadata: { repo: "repo-a" } },
    ]);
    // Phase 0 cleanup calls searchStore.delete() with file paths as IDs.
    // Index a doc with file-path ID to verify it gets cleaned up.
    await searchStore.index([
      { id: "src/old.ts", content: "old function foo", metadata: { repo: "repo-a" } },
    ]);
    await kvStore.set("repo-a:src/old.ts:symbols", "cached-symbols");

    const changeSet = makeChangeSet({
      repo: "repo-a",
      commitHash: "ghi333",
      deletedFiles: ["src/old.ts"],
    });
    mockDetectChanges.mockResolvedValue(changeSet);
    mockClassifyFiles.mockReturnValue([]);

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    // Graph edges cleared for repo (Phase 0 calls graphStore.clear(repo))
    const edges = await graphStore.getEdgesFrom("src/old.ts");
    expect(edges).toHaveLength(0);

    // Search entry for deleted file removed
    const searchResults = await searchStore.search("old function foo");
    expect(searchResults).toHaveLength(0);

    // KV entry cleaned up
    const kvVal = await kvStore.get("repo-a:src/old.ts:symbols");
    expect(kvVal).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Test 4: Parse failure -- commit hash NOT saved
  // -----------------------------------------------------------------------
  it("does not save commit hash when parsing fails", async () => {
    const changeSet = makeChangeSet({
      repo: "repo-a",
      commitHash: "jkl444",
      addedFiles: ["src/broken.ts"],
    });
    mockDetectChanges.mockResolvedValue(changeSet);
    mockClassifyFiles.mockReturnValue([makeClassified("src/broken.ts", "repo-a")]);

    // parseFiles throws
    mockParseFiles.mockRejectedValue(new Error("WASM init failed"));

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    // Commit hash should NOT be saved (parse failure means repo not in parsedFilesByRepo)
    const commitHash = await kvStore.get("commit:repo-a");
    expect(commitHash).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Test 5: Multi-repo partial failure -- unaffected repos still committed
  // -----------------------------------------------------------------------
  it("saves commit hash for successful repos when another fails", async () => {
    const changeSetA = makeChangeSet({
      repo: "repo-a",
      commitHash: "aaa555",
      addedFiles: ["src/a.ts"],
    });
    const changeSetB = makeChangeSet({
      repo: "repo-b",
      commitHash: "bbb555",
      addedFiles: ["src/b.ts"],
    });

    // detectChanges called once per repo
    mockDetectChanges
      .mockResolvedValueOnce(changeSetA)
      .mockResolvedValueOnce(changeSetB);

    mockClassifyFiles
      .mockReturnValueOnce([makeClassified("src/a.ts", "repo-a")])
      .mockReturnValueOnce([makeClassified("src/b.ts", "repo-b")]);

    // repo-a parse succeeds, repo-b parse fails
    mockParseFiles
      .mockResolvedValueOnce(
        makeParseResult([makeParsedFile("src/a.ts", "repo-a")], ["src/a.ts"]),
      )
      .mockRejectedValueOnce(new Error("parse failure in repo-b"));

    mockExtractDepGraph.mockReturnValue({ ...emptyDepGraph, repo: "repo-a" });

    await indexCommand(makeOptions([repoA, repoB], { kvStore, graphStore, searchStore }));

    // repo-a succeeded: commit hash saved
    const commitA = await kvStore.get("commit:repo-a");
    expect(commitA).toBe("aaa555");

    // repo-b failed: commit hash NOT saved
    const commitB = await kvStore.get("commit:repo-b");
    expect(commitB).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Test 6: Tier-1 summary caching -- cache miss writes, cache hit skips I/O
  // -----------------------------------------------------------------------
  it("caches tier-1 summaries by contentHash and serves from cache on re-index", async () => {
    const summaries = [
      { entityId: "src/app.ts#handler", description: "handles requests", tier: 1, confidence: 0.6 },
    ];

    // --- First run: cache miss, tier1Summarize is called and result cached ---
    const changeSet1 = makeChangeSet({
      repo: "repo-a",
      commitHash: "cache1",
      addedFiles: ["src/app.ts"],
    });
    mockDetectChanges.mockResolvedValue(changeSet1);
    mockClassifyFiles.mockReturnValue([makeClassified("src/app.ts", "repo-a")]);
    mockParseFiles.mockResolvedValue(
      makeParseResult([makeParsedFile("src/app.ts", "repo-a")], ["src/app.ts"]),
    );
    mockExtractDepGraph.mockReturnValue({ ...emptyDepGraph, repo: "repo-a" });
    mockTier1Summarize.mockReturnValue(summaries);

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    expect(mockTier1Summarize).toHaveBeenCalledOnce();
    const cacheKey = "summary:t1:repo-a:src/app.ts:abc123";
    const cached = await kvStore.get(cacheKey);
    expect(cached).toBeDefined();
    expect(JSON.parse(cached!)).toEqual(summaries);

    // --- Second run: same contentHash -> cache hit, tier1Summarize NOT called ---
    vi.clearAllMocks();
    mockDetectChanges.mockResolvedValue(
      makeChangeSet({ repo: "repo-a", commitHash: "cache2", addedFiles: ["src/app.ts"] }),
    );
    mockClassifyFiles.mockReturnValue([makeClassified("src/app.ts", "repo-a")]);
    mockParseFiles.mockResolvedValue(
      makeParseResult([makeParsedFile("src/app.ts", "repo-a")], ["src/app.ts"]),
    );
    mockExtractDepGraph.mockReturnValue({ ...emptyDepGraph, repo: "repo-a" });

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    // tier1Summarize should not be called -- served from cache
    expect(mockTier1Summarize).not.toHaveBeenCalled();
    // readFile should not be called for this file -- skipped by cache hit
    expect(mockReadFile).not.toHaveBeenCalled();

    // Summaries should still be indexed in search store
    const results = await searchStore.search("handles requests");
    expect(results.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Test 7: Changed contentHash invalidates summary cache
  // -----------------------------------------------------------------------
  it("invalidates summary cache when contentHash changes", async () => {
    const oldSummaries = [
      { entityId: "src/svc.ts#run", description: "runs service", tier: 1, confidence: 0.6 },
    ];
    const newSummaries = [
      { entityId: "src/svc.ts#run", description: "starts service v2", tier: 1, confidence: 0.6 },
    ];

    // Seed cache with old contentHash
    await kvStore.set(
      "summary:t1:repo-a:src/svc.ts:oldhash",
      JSON.stringify(oldSummaries),
    );

    // Index with a different contentHash
    const pf: ParsedFile = { ...makeParsedFile("src/svc.ts", "repo-a"), contentHash: "newhash" };
    mockDetectChanges.mockResolvedValue(
      makeChangeSet({ repo: "repo-a", commitHash: "inv1", addedFiles: ["src/svc.ts"] }),
    );
    mockClassifyFiles.mockReturnValue([makeClassified("src/svc.ts", "repo-a")]);
    mockParseFiles.mockResolvedValue(makeParseResult([pf], ["src/svc.ts"]));
    mockExtractDepGraph.mockReturnValue({ ...emptyDepGraph, repo: "repo-a" });
    mockTier1Summarize.mockReturnValue(newSummaries);

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    // tier1Summarize called because hash changed (cache miss)
    expect(mockTier1Summarize).toHaveBeenCalledOnce();

    // New result cached under new hash
    const cached = await kvStore.get("summary:t1:repo-a:src/svc.ts:newhash");
    expect(cached).toBeDefined();
    expect(JSON.parse(cached!)).toEqual(newSummaries);
  });
});
