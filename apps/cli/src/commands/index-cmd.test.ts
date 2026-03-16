/**
 * Integration tests for indexCommand: validates incremental indexing behavior.
 *
 * Mocks external packages (ingestion, parsing, structural, heuristics,
 * summarization, models) and uses InMemory stores for real store behavior.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { indexCommand, type IndexOptions, type IndexResult } from "./index-cmd.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("{}"),
}));

vi.mock("@mma/ingestion", () => ({
  detectChanges: vi.fn(),
  classifyFiles: vi.fn().mockReturnValue([]),
  isBareRepo: vi.fn().mockResolvedValue(false),
}));

vi.mock("@mma/parsing", () => ({
  parseFiles: vi.fn(),
}));

vi.mock("@mma/structural", () => ({
  extractDependencyGraph: vi.fn(),
  buildControlFlowGraph: vi.fn(),
  createCfgIdCounter: vi.fn().mockReturnValue({ next: () => 0 }),
  extractCallEdgesFromTreeSitter: vi.fn().mockReturnValue([]),
  computeModuleMetrics: vi.fn().mockReturnValue([]),
  summarizeRepoMetrics: vi.fn().mockReturnValue({
    repo: "", moduleCount: 0, avgInstability: 0, avgAbstractness: 0,
    avgDistance: 0, painZoneCount: 0, uselessnessZoneCount: 0,
  }),
  detectDeadExports: vi.fn().mockReturnValue([]),
  detectInstabilityViolations: vi.fn().mockReturnValue([]),
}));

vi.mock("@mma/heuristics", () => ({
  inferServicesWithMeta: vi.fn().mockReturnValue({ data: [], meta: { repo: "", heuristic: "inferServices", durationMs: 0, itemCount: 0 } }),
  detectPatternsWithMeta: vi.fn().mockReturnValue({ data: [], meta: { repo: "", heuristic: "detectPatterns", durationMs: 0, itemCount: 0 } }),
  scanForFlags: vi.fn().mockReturnValue({ flags: [] }),
  extractLogStatements: vi.fn().mockReturnValue({ repo: "", templates: [] }),
  analyzeNamingWithMeta: vi.fn().mockReturnValue({ data: { methods: [] }, meta: { repo: "", heuristic: "analyzeNaming", durationMs: 0, itemCount: 0 } }),
  extractServiceTopology: vi.fn().mockReturnValue([]),
  evaluateArchRules: vi.fn().mockReturnValue([]),
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

vi.mock("./affected-scope.js", () => ({
  computeAffectedScope: vi.fn().mockResolvedValue(new Map()),
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
    mirrorDir: join(tmpdir(), "mirrors"),
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
import { inferServicesWithMeta, scanForFlags } from "@mma/heuristics";

const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockDetectChanges = detectChanges as ReturnType<typeof vi.fn>;
const mockClassifyFiles = classifyFiles as ReturnType<typeof vi.fn>;
const mockParseFiles = parseFiles as ReturnType<typeof vi.fn>;
const mockExtractDepGraph = extractDependencyGraph as ReturnType<typeof vi.fn>;
const mockTier1Summarize = tier1Summarize as ReturnType<typeof vi.fn>;
const mockInferServices = inferServicesWithMeta as ReturnType<typeof vi.fn>;
const mockScanForFlags = scanForFlags as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("indexCommand", () => {
  let kvStore: InMemoryKVStore;
  let graphStore: InMemoryGraphStore;
  let searchStore: InMemorySearchStore;

  const repoA = { name: "repo-a", url: "https://example.com/a.git", branch: "main", localPath: join(tmpdir(), "mirrors", "repo-a") };
  const repoB = { name: "repo-b", url: "https://example.com/b.git", branch: "main", localPath: join(tmpdir(), "mirrors", "repo-b") };

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
    await kvStore.set("symbols:repo-a:src/old.ts", "cached-symbols");

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
    const kvVal = await kvStore.get("symbols:repo-a:src/old.ts");
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

  // -----------------------------------------------------------------------
  // Test 8: Failure recovery -- incomplete pipeline re-runs Phase 5+
  // -----------------------------------------------------------------------
  it("recovers from incomplete pipeline by loading cached symbols", async () => {
    // Simulate a previous run that completed Phases 3-4b but not the full pipeline:
    // - commit hash saved (Phase 4b done)
    // - symbols cached in KV
    // - pipelineComplete NOT set (Phase 5+ failed)
    // - graph edges persisted
    await kvStore.set("commit:repo-a", "recover1");
    await kvStore.set(
      "symbols:repo-a:src/main.ts",
      JSON.stringify({ symbols: [{ name: "main", kind: "function", path: "src/main.ts", line: 1 }], contentHash: "h1" }),
    );
    await graphStore.addEdges([
      { source: "src/main.ts", target: "src/util.ts", kind: "imports", metadata: { repo: "repo-a" } },
    ]);
    // pipelineComplete is intentionally NOT set

    // detectChanges returns same commit -> empty changeset (no file changes)
    mockDetectChanges.mockResolvedValue(
      makeChangeSet({ repo: "repo-a", commitHash: "recover1", previousCommitHash: "recover1" }),
    );
    mockClassifyFiles.mockReturnValue([]);

    // Phase 5 heuristics will be called on the recovered data
    mockInferServices.mockReturnValue({ data: [], meta: { repo: "", heuristic: "inferServices", durationMs: 0, itemCount: 0 } });
    mockTier1Summarize.mockReturnValue([
      { entityId: "src/main.ts#main", description: "main function", tier: 1, confidence: 0.7 },
    ]);

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    // parseFiles should NOT be called (recovery skips Phase 3)
    expect(mockParseFiles).not.toHaveBeenCalled();

    // inferServices should be called (Phase 5 re-runs)
    expect(mockInferServices).toHaveBeenCalled();

    // Summaries should be indexed in search store
    const results = await searchStore.search("main function");
    expect(results.length).toBeGreaterThan(0);

    // pipelineComplete should now be set (full pipeline completed)
    const complete = await kvStore.get("pipelineComplete:repo-a");
    expect(complete).toBe("true");
  });

  // -----------------------------------------------------------------------
  // Test 9: Returns true when changes were detected
  // -----------------------------------------------------------------------
  it("returns true when repos have changed files", async () => {
    mockDetectChanges.mockResolvedValue(
      makeChangeSet({ repo: "repo-a", commitHash: "ret1", addedFiles: ["src/new.ts"] }),
    );
    mockClassifyFiles.mockReturnValue([makeClassified("src/new.ts", "repo-a")]);
    mockParseFiles.mockResolvedValue(
      makeParseResult([makeParsedFile("src/new.ts", "repo-a")], ["src/new.ts"]),
    );
    mockExtractDepGraph.mockReturnValue({ ...emptyDepGraph, repo: "repo-a" });

    const result: IndexResult = await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));
    expect(result.hadChanges).toBe(true);
    expect(result.repoCount).toBe(1);
    expect(result.totalFiles).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Test 10: Returns false when no changes were detected
  // -----------------------------------------------------------------------
  it("returns false when no repos have changed files", async () => {
    await kvStore.set("commit:repo-a", "nochange1");
    await kvStore.set("pipelineComplete:repo-a", "true");

    mockDetectChanges.mockResolvedValue(
      makeChangeSet({ repo: "repo-a", commitHash: "nochange1", previousCommitHash: "nochange1" }),
    );
    mockClassifyFiles.mockReturnValue([]);

    const result: IndexResult = await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));
    expect(result.hadChanges).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 11: Incremental indexing -- modify one file, graph matches full re-index
  // -----------------------------------------------------------------------
  it("incremental index after modifying one file matches full re-index", async () => {
    // --- Run 1: Full index of 3 files with edges a→b, b→c ---
    const changeSet1 = makeChangeSet({
      repo: "repo-a",
      commitHash: "inc1",
      addedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    mockDetectChanges.mockResolvedValue(changeSet1);

    const classified1 = [
      makeClassified("src/a.ts", "repo-a"),
      makeClassified("src/b.ts", "repo-a"),
      makeClassified("src/c.ts", "repo-a"),
    ];
    mockClassifyFiles.mockReturnValue(classified1);

    const parsedFiles1 = [
      { ...makeParsedFile("src/a.ts", "repo-a"), contentHash: "a-v1" },
      { ...makeParsedFile("src/b.ts", "repo-a"), contentHash: "b-v1" },
      { ...makeParsedFile("src/c.ts", "repo-a"), contentHash: "c-v1" },
    ];
    mockParseFiles.mockResolvedValue(
      makeParseResult(parsedFiles1, ["src/a.ts", "src/b.ts", "src/c.ts"]),
    );

    const edgeAB: GraphEdge = { source: "src/a.ts", target: "src/b.ts", kind: "imports", metadata: { repo: "repo-a" } };
    const edgeBC: GraphEdge = { source: "src/b.ts", target: "src/c.ts", kind: "imports", metadata: { repo: "repo-a" } };
    mockExtractDepGraph.mockReturnValue({
      repo: "repo-a",
      edges: [edgeAB, edgeBC],
      circularDependencies: [],
    });

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    // Verify full index: 2 import edges
    const edgesAfterRun1 = await graphStore.getEdgesByKind("imports", "repo-a");
    expect(edgesAfterRun1).toHaveLength(2);
    expect(edgesAfterRun1.some((e: GraphEdge) => e.source === "src/a.ts" && e.target === "src/b.ts")).toBe(true);
    expect(edgesAfterRun1.some((e: GraphEdge) => e.source === "src/b.ts" && e.target === "src/c.ts")).toBe(true);

    // Verify symbols cached for all 3 files
    expect(await kvStore.get("symbols:repo-a:src/a.ts")).toBeDefined();
    expect(await kvStore.get("symbols:repo-a:src/b.ts")).toBeDefined();
    expect(await kvStore.get("symbols:repo-a:src/c.ts")).toBeDefined();

    // --- Run 2: Incremental -- modify a.ts (new edge a→c replacing a→b) ---
    vi.clearAllMocks();

    const changeSet2 = makeChangeSet({
      repo: "repo-a",
      commitHash: "inc2",
      previousCommitHash: "inc1",
      modifiedFiles: ["src/a.ts"],
    });
    mockDetectChanges.mockResolvedValue(changeSet2);
    mockClassifyFiles.mockReturnValue([makeClassified("src/a.ts", "repo-a")]);

    // parseFiles only returns the changed file
    const parsedFiles2 = [
      { ...makeParsedFile("src/a.ts", "repo-a"), contentHash: "a-v2" },
    ];
    mockParseFiles.mockResolvedValue(
      makeParseResult(parsedFiles2, ["src/a.ts"]),
    );

    // extractDependencyGraph returns new edge for the changed file only
    const edgeAC: GraphEdge = { source: "src/a.ts", target: "src/c.ts", kind: "imports", metadata: { repo: "repo-a" } };
    mockExtractDepGraph.mockReturnValue({
      repo: "repo-a",
      edges: [edgeAC],
      circularDependencies: [],
    });

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    // Verify incremental result: a→c and b→c (old a→b removed)
    const edgesIncremental = await graphStore.getEdgesByKind("imports", "repo-a");
    expect(edgesIncremental).toHaveLength(2);
    expect(edgesIncremental.some((e: GraphEdge) => e.source === "src/a.ts" && e.target === "src/c.ts")).toBe(true);
    expect(edgesIncremental.some((e: GraphEdge) => e.source === "src/b.ts" && e.target === "src/c.ts")).toBe(true);
    // Old edge a→b must be gone
    expect(edgesIncremental.some((e: GraphEdge) => e.source === "src/a.ts" && e.target === "src/b.ts")).toBe(false);

    // Verify cached symbols include all 3 files (b.ts and c.ts from cache)
    expect(await kvStore.get("symbols:repo-a:src/a.ts")).toBeDefined();
    expect(await kvStore.get("symbols:repo-a:src/b.ts")).toBeDefined();
    expect(await kvStore.get("symbols:repo-a:src/c.ts")).toBeDefined();
    // a.ts should have updated contentHash
    const aSymbols = JSON.parse((await kvStore.get("symbols:repo-a:src/a.ts"))!);
    expect(aSymbols.contentHash).toBe("a-v2");

    // --- Run 3: Full re-index with same state -- result should match incremental ---
    vi.clearAllMocks();

    const changeSet3 = makeChangeSet({
      repo: "repo-a",
      commitHash: "inc3",
      previousCommitHash: "inc2",
      addedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    mockDetectChanges.mockResolvedValue(changeSet3);
    mockClassifyFiles.mockReturnValue([
      makeClassified("src/a.ts", "repo-a"),
      makeClassified("src/b.ts", "repo-a"),
      makeClassified("src/c.ts", "repo-a"),
    ]);

    const parsedFiles3 = [
      { ...makeParsedFile("src/a.ts", "repo-a"), contentHash: "a-v2" },
      { ...makeParsedFile("src/b.ts", "repo-a"), contentHash: "b-v1" },
      { ...makeParsedFile("src/c.ts", "repo-a"), contentHash: "c-v1" },
    ];
    mockParseFiles.mockResolvedValue(
      makeParseResult(parsedFiles3, ["src/a.ts", "src/b.ts", "src/c.ts"]),
    );

    // Same edges as after modification: a→c and b→c
    mockExtractDepGraph.mockReturnValue({
      repo: "repo-a",
      edges: [edgeAC, edgeBC],
      circularDependencies: [],
    });

    await indexCommand({
      ...makeOptions([repoA], { kvStore, graphStore, searchStore }),
      forceFullReindex: true,
    });

    // Full re-index should produce identical edges
    const edgesFullReindex = await graphStore.getEdgesByKind("imports", "repo-a");
    expect(edgesFullReindex).toHaveLength(2);
    expect(edgesFullReindex.some((e: GraphEdge) => e.source === "src/a.ts" && e.target === "src/c.ts")).toBe(true);
    expect(edgesFullReindex.some((e: GraphEdge) => e.source === "src/b.ts" && e.target === "src/c.ts")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 12: Incremental indexing -- delete one file, edges cleaned up
  // -----------------------------------------------------------------------
  it("incremental index removes edges when a file is deleted", async () => {
    // --- Run 1: Full index of 3 files ---
    mockDetectChanges.mockResolvedValue(
      makeChangeSet({ repo: "repo-a", commitHash: "del1", addedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] }),
    );
    mockClassifyFiles.mockReturnValue([
      makeClassified("src/a.ts", "repo-a"),
      makeClassified("src/b.ts", "repo-a"),
      makeClassified("src/c.ts", "repo-a"),
    ]);
    mockParseFiles.mockResolvedValue(
      makeParseResult([
        { ...makeParsedFile("src/a.ts", "repo-a"), contentHash: "a1" },
        { ...makeParsedFile("src/b.ts", "repo-a"), contentHash: "b1" },
        { ...makeParsedFile("src/c.ts", "repo-a"), contentHash: "c1" },
      ], ["src/a.ts", "src/b.ts", "src/c.ts"]),
    );
    mockExtractDepGraph.mockReturnValue({
      repo: "repo-a",
      edges: [
        { source: "src/a.ts", target: "src/b.ts", kind: "imports", metadata: { repo: "repo-a" } },
        { source: "src/b.ts", target: "src/c.ts", kind: "imports", metadata: { repo: "repo-a" } },
      ],
      circularDependencies: [],
    });

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));
    expect(await graphStore.getEdgesByKind("imports", "repo-a")).toHaveLength(2);

    // --- Run 2: Delete b.ts (edge b→c should be removed, a→b target orphaned) ---
    vi.clearAllMocks();

    mockDetectChanges.mockResolvedValue(
      makeChangeSet({ repo: "repo-a", commitHash: "del2", previousCommitHash: "del1", deletedFiles: ["src/b.ts"] }),
    );
    mockClassifyFiles.mockReturnValue([]);

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    const edgesAfterDelete = await graphStore.getEdgesByKind("imports", "repo-a");
    // b→c edge should be gone (b.ts was source), a→b still exists (a.ts is source)
    expect(edgesAfterDelete.some((e: GraphEdge) => e.source === "src/b.ts")).toBe(false);
    expect(edgesAfterDelete.some((e: GraphEdge) => e.source === "src/a.ts" && e.target === "src/b.ts")).toBe(true);
    expect(edgesAfterDelete).toHaveLength(1);

    // KV symbols for b.ts should be cleaned up
    expect(await kvStore.get("symbols:repo-a:src/b.ts")).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Test 13: Incremental indexing -- flag scanning merges with cached flags
  // -----------------------------------------------------------------------
  it("incremental index merges new flags with cached flags from unchanged files", async () => {
    // --- Run 1: Full index with flags in two files ---
    mockDetectChanges.mockResolvedValue(
      makeChangeSet({ repo: "repo-a", commitHash: "flag1", addedFiles: ["src/a.ts", "src/b.ts"] }),
    );
    mockClassifyFiles.mockReturnValue([
      makeClassified("src/a.ts", "repo-a"),
      makeClassified("src/b.ts", "repo-a"),
    ]);
    mockParseFiles.mockResolvedValue(
      makeParseResult([
        { ...makeParsedFile("src/a.ts", "repo-a"), contentHash: "a1" },
        { ...makeParsedFile("src/b.ts", "repo-a"), contentHash: "b1" },
      ], ["src/a.ts", "src/b.ts"]),
    );
    mockExtractDepGraph.mockReturnValue({ ...emptyDepGraph, repo: "repo-a" });

    // scanForFlags returns flags from both files
    mockScanForFlags.mockReturnValue({
      repo: "repo-a",
      flags: [
        { name: "DARK_MODE", locations: [{ repo: "repo-a", module: "src/a.ts" }], sdk: "launchdarkly" },
        { name: "NEW_UI", locations: [{ repo: "repo-a", module: "src/b.ts" }], sdk: "launchdarkly" },
      ],
    });

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    const flags1 = JSON.parse((await kvStore.get("flags:repo-a"))!);
    expect(flags1.flags).toHaveLength(2);

    // --- Run 2: Incremental -- modify a.ts only, b.ts unchanged ---
    vi.clearAllMocks();

    mockDetectChanges.mockResolvedValue(
      makeChangeSet({ repo: "repo-a", commitHash: "flag2", previousCommitHash: "flag1", modifiedFiles: ["src/a.ts"] }),
    );
    mockClassifyFiles.mockReturnValue([makeClassified("src/a.ts", "repo-a")]);
    mockParseFiles.mockResolvedValue(
      makeParseResult([{ ...makeParsedFile("src/a.ts", "repo-a"), contentHash: "a2" }], ["src/a.ts"]),
    );
    mockExtractDepGraph.mockReturnValue({ ...emptyDepGraph, repo: "repo-a" });

    // scanForFlags only sees a.ts tree -- returns updated flag for a.ts
    mockScanForFlags.mockReturnValue({
      repo: "repo-a",
      flags: [
        { name: "DARK_MODE", locations: [{ repo: "repo-a", module: "src/a.ts" }], sdk: "launchdarkly" },
        { name: "BETA_FEATURE", locations: [{ repo: "repo-a", module: "src/a.ts" }], sdk: "launchdarkly" },
      ],
    });

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    // Should have 3 flags: DARK_MODE (a.ts), NEW_UI (b.ts, cached), BETA_FEATURE (a.ts, new)
    const flags2 = JSON.parse((await kvStore.get("flags:repo-a"))!);
    const flagNames = flags2.flags.map((f: { name: string }) => f.name).sort();
    expect(flagNames).toEqual(["BETA_FEATURE", "DARK_MODE", "NEW_UI"]);

    // NEW_UI should still reference b.ts (unchanged file, preserved from cache)
    const newUiFlag = flags2.flags.find((f: { name: string }) => f.name === "NEW_UI");
    expect(newUiFlag.locations).toHaveLength(1);
    expect(newUiFlag.locations[0].module).toBe("src/b.ts");
  });

  // -----------------------------------------------------------------------
  // Test 14: pipelineComplete flag prevents recovery on fully-completed repo
  // -----------------------------------------------------------------------
  it("skips recovery when pipelineComplete is set", async () => {
    // Simulate a fully completed previous run
    await kvStore.set("commit:repo-a", "done1");
    await kvStore.set("pipelineComplete:repo-a", "true");
    await kvStore.set(
      "symbols:repo-a:src/app.ts",
      JSON.stringify({ symbols: [], contentHash: "h2" }),
    );

    // detectChanges returns same commit -> no changes
    mockDetectChanges.mockResolvedValue(
      makeChangeSet({ repo: "repo-a", commitHash: "done1", previousCommitHash: "done1" }),
    );
    mockClassifyFiles.mockReturnValue([]);

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    // Neither parse nor heuristics should run (repo fully completed, skipped)
    expect(mockParseFiles).not.toHaveBeenCalled();
    expect(mockInferServices).not.toHaveBeenCalled();
  });
});
