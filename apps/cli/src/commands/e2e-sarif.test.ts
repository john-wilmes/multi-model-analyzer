/**
 * E2E validation: verifies SARIF output consistency across multiple
 * pipeline runs with the same input.
 *
 * Uses in-memory stores and mocked external packages (same as index-cmd.test.ts).
 * Validates that:
 * 1. Two identical runs produce identical SARIF output
 * 2. Baseline state tracking works across runs
 * 3. Pipeline trace is recorded consistently
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  ChangeSet,
  ParsedFile,
  ClassifiedFile,
  SarifLog,
  SarifResult,
} from "@mma/core";
import {
  InMemoryGraphStore,
  InMemorySearchStore,
  InMemoryKVStore,
} from "@mma/storage";
import { indexCommand, type IndexOptions } from "./index-cmd.js";

// ---------------------------------------------------------------------------
// Mocks (same pattern as index-cmd.test.ts)
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
  computeModuleMetrics: vi.fn().mockReturnValue([]),
  summarizeRepoMetrics: vi.fn().mockReturnValue({
    repo: "", moduleCount: 0, avgInstability: 0, avgAbstractness: 0,
    avgDistance: 0, painZoneCount: 0, uselessnessZoneCount: 0,
  }),
  detectDeadExports: vi.fn().mockReturnValue([]),
  detectInstabilityViolations: vi.fn().mockReturnValue([]),
}));

vi.mock("@mma/heuristics", () => ({
  inferServices: vi.fn().mockReturnValue([]),
  detectPatterns: vi.fn().mockReturnValue([]),
  scanForFlags: vi.fn().mockReturnValue({ flags: [] }),
  extractLogStatements: vi.fn().mockReturnValue({ repo: "", templates: [] }),
  analyzeNaming: vi.fn().mockReturnValue({ methods: [] }),
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

function makeChangeSet(repo: string, commitHash: string, addedFiles: string[] = []): ChangeSet {
  return {
    repo,
    commitHash,
    previousCommitHash: null,
    addedFiles,
    modifiedFiles: [],
    deletedFiles: [],
    timestamp: new Date("2026-03-09T00:00:00Z"),
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
    symbols: [{ name: "Foo", kind: "class", startLine: 1, endLine: 10, exported: true }],
    contentHash: `hash-${path}`,
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
      symbolCount: parsedFiles.reduce((sum, pf) => sum + pf.symbols.length, 0),
      errorCount: 0,
      treeSitterTimeMs: 0,
      tsMorphTimeMs: 0,
    },
  };
}

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
// Import mocked modules
// ---------------------------------------------------------------------------

import { detectChanges, classifyFiles } from "@mma/ingestion";
import { parseFiles } from "@mma/parsing";
import { extractDependencyGraph } from "@mma/structural";
import { detectDeadExports, detectInstabilityViolations } from "@mma/structural";

const mockDetectChanges = detectChanges as ReturnType<typeof vi.fn>;
const mockClassifyFiles = classifyFiles as ReturnType<typeof vi.fn>;
const mockParseFiles = parseFiles as ReturnType<typeof vi.fn>;
const mockExtractDepGraph = extractDependencyGraph as ReturnType<typeof vi.fn>;
const mockDetectDeadExports = detectDeadExports as ReturnType<typeof vi.fn>;
const mockDetectInstabilityViolations = detectInstabilityViolations as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E SARIF consistency", () => {
  const repoA = { name: "repo-a", url: "https://example.com/a.git", branch: "main", localPath: join(tmpdir(), "mirrors", "repo-a") };

  let kvStore: InMemoryKVStore;
  let graphStore: InMemoryGraphStore;
  let searchStore: InMemorySearchStore;

  const sarifResults: SarifResult[] = [
    {
      ruleId: "dead-export/unused",
      level: "warning",
      message: { text: "Unused export: Foo in src/index.ts" },
      locations: [{
        logicalLocations: [{
          name: "src/index.ts",
          fullyQualifiedName: "repo-a/src/index.ts#Foo",
          kind: "module",
        }],
      }],
    },
  ];

  function setupMocksForRun(commitHash: string) {
    const changeSet = makeChangeSet("repo-a", commitHash, ["src/index.ts"]);
    mockDetectChanges.mockResolvedValue(changeSet);
    mockClassifyFiles.mockReturnValue([makeClassified("src/index.ts", "repo-a")]);
    mockParseFiles.mockResolvedValue(
      makeParseResult([makeParsedFile("src/index.ts", "repo-a")], ["src/index.ts"]),
    );
    mockExtractDepGraph.mockReturnValue({
      repo: "repo-a",
      edges: [],
      circularDependencies: [],
    });
    mockDetectDeadExports.mockReturnValue(sarifResults);
    mockDetectInstabilityViolations.mockReturnValue([]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    kvStore = new InMemoryKVStore();
    graphStore = new InMemoryGraphStore();
    searchStore = new InMemorySearchStore();
    fakeTreeDelete.mockReset();
  });

  it("produces SARIF output on first run", async () => {
    setupMocksForRun("commit-1");

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    const sarifJson = await kvStore.get("sarif:latest");
    expect(sarifJson).toBeDefined();

    const sarif = JSON.parse(sarifJson!) as SarifLog;
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0]!.results.length).toBeGreaterThan(0);
  });

  it("produces consistent SARIF across two identical runs", async () => {
    setupMocksForRun("commit-1");
    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    const firstRunJson = await kvStore.get("sarif:latest");
    const firstRun = JSON.parse(firstRunJson!) as SarifLog;

    // Second run with same input
    vi.clearAllMocks();
    fakeTreeDelete.mockReset();
    setupMocksForRun("commit-2");
    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    const secondRunJson = await kvStore.get("sarif:latest");
    const secondRun = JSON.parse(secondRunJson!) as SarifLog;

    // Results should have same ruleIds and messages
    const firstRuleIds = firstRun.runs[0]!.results.map(r => r.ruleId).sort();
    const secondRuleIds = secondRun.runs[0]!.results.map(r => r.ruleId).sort();
    expect(secondRuleIds).toEqual(firstRuleIds);

    // Second run should have baseline state "unchanged"
    const unchangedResults = secondRun.runs[0]!.results.filter(
      r => r.baselineState === "unchanged",
    );
    expect(unchangedResults.length).toBeGreaterThan(0);
  });

  it("marks absent results when findings disappear", async () => {
    // First run with SARIF results
    setupMocksForRun("commit-1");
    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    // Second run with no findings
    vi.clearAllMocks();
    fakeTreeDelete.mockReset();
    setupMocksForRun("commit-2");
    mockDetectDeadExports.mockReturnValue([]); // no dead exports this time

    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    const sarifJson = await kvStore.get("sarif:latest");
    const sarif = JSON.parse(sarifJson!) as SarifLog;

    // Previous results should show up as "absent"
    const absentResults = sarif.runs[0]!.results.filter(
      r => r.baselineState === "absent",
    );
    expect(absentResults.length).toBeGreaterThan(0);
  });

  it("stores pipeline trace in KV", async () => {
    setupMocksForRun("commit-1");
    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    const traceJson = await kvStore.get("pipeline:trace:latest");
    expect(traceJson).toBeDefined();

    const trace = JSON.parse(traceJson!) as { phases: unknown[]; totalDurationMs: number };
    expect(trace.phases.length).toBeGreaterThan(0);
    expect(trace.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("records pipelineComplete flag after successful run", async () => {
    setupMocksForRun("commit-1");
    await indexCommand(makeOptions([repoA], { kvStore, graphStore, searchStore }));

    const complete = await kvStore.get("pipelineComplete:repo-a");
    expect(complete).toBe("true");
  });
});
