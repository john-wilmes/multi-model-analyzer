import { describe, it, expect, beforeEach, vi } from "vitest";
import { InMemoryKVStore, InMemoryGraphStore } from "@mma/storage";
import {
  mulberry32,
  sampleN,
  ValidationReporter,
  checkDeadExport,
  checkUnstableDependency,
  checkThresholdConsistency,
  checkFault,
  checkBlastRadius,
  validateCommand,
  resetCaches,
} from "./validate-cmd.js";

vi.mock("@mma/ingestion", async () => {
  const actual = await vi.importActual("@mma/ingestion");
  return {
    ...actual,
    getFileContent: vi.fn(),
    getHeadCommit: vi.fn(),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

import { getFileContent, getHeadCommit } from "@mma/ingestion";
import { existsSync } from "node:fs";

// ─── mulberry32 + sampleN ───────────────────────────────────

describe("mulberry32", () => {
  it("produces same sequence for the same seed", () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);
    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());
    expect(seq1).toEqual(seq2);
  });

  it("produces different sequences for different seeds", () => {
    const rng1 = mulberry32(1);
    const rng2 = mulberry32(2);
    expect(rng1()).not.toBe(rng2());
  });

  it("returns values in [0, 1)", () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("sampleN", () => {
  it("returns all items when n >= arr.length", () => {
    const arr = [1, 2, 3];
    const result = sampleN(arr, 10, mulberry32(1));
    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it("returns exactly n items when n < arr.length", () => {
    const arr = [1, 2, 3, 4, 5];
    const result = sampleN(arr, 3, mulberry32(1));
    expect(result).toHaveLength(3);
  });

  it("is deterministic with the same seed", () => {
    const arr = ["a", "b", "c", "d", "e"];
    const r1 = sampleN(arr, 3, mulberry32(7));
    const r2 = sampleN(arr, 3, mulberry32(7));
    expect(r1).toEqual(r2);
  });

  it("does not mutate the original array", () => {
    const arr = [1, 2, 3, 4, 5];
    const copy = [...arr];
    sampleN(arr, 3, mulberry32(1));
    expect(arr).toEqual(copy);
  });
});

// ─── Shared helpers ─────────────────────────────────────────

function makeRng() {
  return mulberry32(42);
}

// ─── checkDeadExport ────────────────────────────────────────

describe("checkDeadExport", () => {
  let kv: InMemoryKVStore;
  let graph: InMemoryGraphStore;
  let reporter: ValidationReporter;

  beforeEach(() => {
    resetCaches();
    kv = new InMemoryKVStore();
    graph = new InMemoryGraphStore();
    reporter = new ValidationReporter();
  });

  it("records a pass when flagged file is NOT an import target", async () => {
    // src/orphan.ts is flagged as dead but nothing imports it — true positive
    const findings = [
      {
        ruleId: "structural/dead-export",
        level: "warning",
        message: { text: "Dead export" },
        locations: [{ logicalLocations: [{ fullyQualifiedName: "src/orphan.ts#MyClass" }] }],
      },
    ];
    await kv.set("sarif:deadExports:repo1", JSON.stringify(findings));

    // Only src/a.ts imports src/b.ts — orphan.ts is never a target
    // repo is stored in metadata, not as a top-level field (InMemoryGraphStore filters on metadata.repo)
    await graph.addEdges([
      { source: "src/a.ts", target: "src/b.ts", kind: "imports", metadata: { repo: "repo1" } },
    ]);

    await checkDeadExport(kv, graph, reporter, 50, makeRng());

    const passes = reporter.counts.pass;
    expect(passes).toBeGreaterThanOrEqual(1);
    expect(reporter.counts.fail).toBe(0);
  });

  it("records a skip when flagged file IS an import target (file-level only)", async () => {
    // src/imported.ts is flagged as dead but IS actually imported at file level —
    // we can't verify symbol-level, so this should skip (not fail)
    const findings = [
      {
        ruleId: "structural/dead-export",
        level: "warning",
        message: { text: "Dead export" },
        locations: [{ logicalLocations: [{ fullyQualifiedName: "src/imported.ts#SomeExport" }] }],
      },
    ];
    await kv.set("sarif:deadExports:repo1", JSON.stringify(findings));

    // src/a.ts imports src/imported.ts — but we don't know if SomeExport is used
    await graph.addEdges([
      { source: "src/a.ts", target: "src/imported.ts", kind: "imports", metadata: { repo: "repo1" } },
    ]);

    await checkDeadExport(kv, graph, reporter, 50, makeRng());

    expect(reporter.counts.skip).toBeGreaterThanOrEqual(1);
    expect(reporter.counts.fail).toBe(0);
  });

  it("skips when there are no findings", async () => {
    await checkDeadExport(kv, graph, reporter, 50, makeRng());
    expect(reporter.counts.skip).toBeGreaterThanOrEqual(1);
    expect(reporter.counts.pass).toBe(0);
    expect(reporter.counts.fail).toBe(0);
  });
});

// ─── checkUnstableDependency ────────────────────────────────

describe("checkUnstableDependency", () => {
  let kv: InMemoryKVStore;
  let graph: InMemoryGraphStore;
  let reporter: ValidationReporter;

  beforeEach(() => {
    resetCaches();
    kv = new InMemoryKVStore();
    graph = new InMemoryGraphStore();
    reporter = new ValidationReporter();
  });

  it("records a pass when reported instability matches graph computation", async () => {
    // src/stable.ts: ca=3 (x,y,z import it), ce=1 (imports unstable) => I = 1/4 = 0.25
    // src/unstable.ts: ca=1 (stable imports it), ce=3 (imports p,q,r) => I = 3/4 = 0.75
    // Finding: stable (I=0.25) depends on unstable (I=0.75) — delta = 0.75-0.25 = 0.50 > 0.3
    const findings = [
      {
        ruleId: "structural/unstable-dependency",
        level: "warning",
        message: { text: "src/stable.ts (I=0.25) depends on src/unstable.ts (I=0.75): threshold=0.3" },
        locations: [{ logicalLocations: [{ fullyQualifiedName: "src/stable.ts" }] }],
      },
    ];
    await kv.set("sarif:instability:repo1", JSON.stringify(findings));

    await graph.addEdges([
      // stable imports unstable (the flagged dependency)
      { source: "src/stable.ts", target: "src/unstable.ts", kind: "imports", metadata: { repo: "repo1" } },
      // x,y,z import stable (gives stable ca=3)
      { source: "src/x.ts", target: "src/stable.ts", kind: "imports", metadata: { repo: "repo1" } },
      { source: "src/y.ts", target: "src/stable.ts", kind: "imports", metadata: { repo: "repo1" } },
      { source: "src/z.ts", target: "src/stable.ts", kind: "imports", metadata: { repo: "repo1" } },
      // unstable imports p,q,r (gives unstable ce=3)
      { source: "src/unstable.ts", target: "src/p.ts", kind: "imports", metadata: { repo: "repo1" } },
      { source: "src/unstable.ts", target: "src/q.ts", kind: "imports", metadata: { repo: "repo1" } },
      { source: "src/unstable.ts", target: "src/r.ts", kind: "imports", metadata: { repo: "repo1" } },
    ]);

    await checkUnstableDependency(kv, graph, reporter, 50, makeRng());

    expect(reporter.counts.fail).toBe(0);
  });

  it("records a fail when the reported instability values do not match graph", async () => {
    // Report claims I=0.10 for src/a.ts but graph gives I=1.00 (only Ce, no Ca)
    const findings = [
      {
        ruleId: "structural/unstable-dependency",
        level: "warning",
        message: { text: "src/b.ts (I=0.10) depends on src/a.ts (I=0.90): threshold=0.3" },
        locations: [{ logicalLocations: [{ fullyQualifiedName: "src/b.ts->src/a.ts" }] }],
      },
    ];
    await kv.set("sarif:instability:repo1", JSON.stringify(findings));

    // b imports a; b has Ce=1, Ca=0 => I(b)=1.0 (not 0.10 as reported)
    await graph.addEdges([
      { source: "src/b.ts", target: "src/a.ts", kind: "imports", metadata: { repo: "repo1" } },
    ]);

    await checkUnstableDependency(kv, graph, reporter, 50, makeRng());

    expect(reporter.counts.fail).toBeGreaterThanOrEqual(1);
  });
});

// ─── checkThresholdConsistency ──────────────────────────────

describe("checkThresholdConsistency", () => {
  let kv: InMemoryKVStore;
  let reporter: ValidationReporter;

  beforeEach(() => {
    resetCaches();
    kv = new InMemoryKVStore();
    reporter = new ValidationReporter();
  });

  it("passes when all SDP findings use threshold=0.3", async () => {
    const findings = [
      {
        ruleId: "structural/unstable-dependency",
        level: "warning",
        message: { text: "src/a.ts (I=0.20) depends on src/b.ts (I=0.80): threshold=0.3" },
      },
      {
        ruleId: "structural/unstable-dependency",
        level: "warning",
        message: { text: "src/c.ts (I=0.10) depends on src/d.ts (I=0.90): threshold=0.3" },
      },
    ];
    await kv.set("sarif:instability:repo1", JSON.stringify(findings));

    await checkThresholdConsistency(kv, reporter);

    expect(reporter.counts.fail).toBe(0);
    expect(reporter.counts.pass).toBe(1);
  });

  it("fails when a finding uses a non-0.3 threshold", async () => {
    const findings = [
      {
        ruleId: "structural/unstable-dependency",
        level: "warning",
        message: { text: "src/a.ts (I=0.20) depends on src/b.ts (I=0.80): threshold=0.5" },
      },
    ];
    await kv.set("sarif:instability:repo1", JSON.stringify(findings));

    await checkThresholdConsistency(kv, reporter);

    expect(reporter.counts.fail).toBe(1);
  });

  it("passes when no SDP findings exist (empty KV)", async () => {
    // kv is empty — no instability keys at all
    await checkThresholdConsistency(kv, reporter);

    // inconsistent === 0 => reporter.pass branch
    expect(reporter.counts.pass).toBe(1);
    expect(reporter.counts.fail).toBe(0);
  });
});

// ─── checkFault (no mirrorsDir) ─────────────────────────────

describe("checkFault", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("records exactly 2 skips and no crash when mirrorsDir is undefined", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    const reporter = new ValidationReporter();

    // Seed some fault findings to confirm early-exit skips, not "no findings" skips
    const findings = [
      {
        ruleId: "structural/fault",
        level: "error",
        message: { text: "Silent catch block" },
        locations: [{ logicalLocations: [{ fullyQualifiedName: "src/service.ts#handleRequest" }] }],
      },
    ];
    await kv.set("sarif:fault:repo1", JSON.stringify(findings));

    await checkFault(kv, graph, reporter, 50, makeRng(), undefined);

    expect(reporter.counts.skip).toBe(2);
    expect(reporter.counts.fail).toBe(0);
    expect(reporter.counts.pass).toBe(0);
  });

  it("precision: pass when source has a silent catch block", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    const reporter = new ValidationReporter();

    const findings = [
      {
        ruleId: "structural/fault",
        level: "error",
        message: { text: "Silent catch block" },
        locations: [
          {
            logicalLocations: [
              { fullyQualifiedName: "src/handler.ts#handleRequest#catch" },
            ],
          },
        ],
      },
    ];
    await kv.set("sarif:fault:repo1", JSON.stringify(findings));

    // existsSync: true for both mirrorsDir and repoDir checks
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(getHeadCommit).mockResolvedValue("abc123");
    // Silent catch: no logging, no rethrow
    vi.mocked(getFileContent).mockResolvedValue(
      "function handle() { try { foo(); } catch(e) { } }",
    );

    await checkFault(kv, graph, reporter, 50, makeRng(), "/tmp/mirrors");

    expect(reporter.counts.pass).toBeGreaterThanOrEqual(1);
    expect(reporter.counts.fail).toBe(0);
  });

  it("precision: fail when all catch blocks have logging", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    const reporter = new ValidationReporter();

    const findings = [
      {
        ruleId: "structural/fault",
        level: "error",
        message: { text: "Silent catch block" },
        locations: [
          {
            logicalLocations: [
              { fullyQualifiedName: "src/handler.ts#handleRequest#catch" },
            ],
          },
        ],
      },
    ];
    await kv.set("sarif:fault:repo1", JSON.stringify(findings));

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(getHeadCommit).mockResolvedValue("abc123");
    // Catch with console.error — not silent
    vi.mocked(getFileContent).mockResolvedValue(
      "function handle() { try { foo(); } catch(e) { console.error(e); } }",
    );

    await checkFault(kv, graph, reporter, 50, makeRng(), "/tmp/mirrors");

    expect(reporter.counts.fail).toBeGreaterThanOrEqual(1);
  });

  it("precision: skips when finding has no module path (empty FQN)", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    const reporter = new ValidationReporter();

    // FQN starts with '#' so split('#')[0] is empty string
    const findings = [
      {
        ruleId: "structural/fault",
        level: "error",
        message: { text: "Silent catch block" },
        locations: [
          {
            logicalLocations: [{ fullyQualifiedName: "#handleRequest#catch" }],
          },
        ],
      },
    ];
    await kv.set("sarif:fault:repo1", JSON.stringify(findings));

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(getHeadCommit).mockResolvedValue("abc123");
    vi.mocked(getFileContent).mockResolvedValue("");

    await checkFault(kv, graph, reporter, 50, makeRng(), "/tmp/mirrors");

    // The finding with empty modulePath yields a skip, not a pass or fail
    expect(reporter.counts.skip).toBeGreaterThanOrEqual(1);
    expect(reporter.counts.fail).toBe(0);
    expect(reporter.counts.pass).toBe(0);
  });

  it("recall: passes when unflagged files have no silent catch", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    const reporter = new ValidationReporter();

    // Seed a fault finding to populate allFault (so repos list is non-empty for recall)
    const findings = [
      {
        ruleId: "structural/fault",
        level: "error",
        message: { text: "Silent catch block" },
        locations: [
          {
            logicalLocations: [
              { fullyQualifiedName: "src/flagged.ts#doThing#catch" },
            ],
          },
        ],
      },
    ];
    await kv.set("sarif:fault:repo1", JSON.stringify(findings));

    // Add import edges so getImportEdges returns files for repo1;
    // src/other.ts is unflagged and will be sampled for recall
    await graph.addEdges([
      {
        source: "src/flagged.ts",
        target: "src/other.ts",
        kind: "imports",
        metadata: { repo: "repo1" },
      },
    ]);

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(getHeadCommit).mockResolvedValue("abc123");
    // src/flagged.ts (precision target) has a silent catch so precision passes;
    // src/other.ts (recall target) has a catch with logging — no silent catch => recall pass
    vi.mocked(getFileContent).mockImplementation(async (_repo, _commit, filePath) => {
      if (filePath === "src/flagged.ts") {
        return "function flagged() { try { foo(); } catch(e) { } }";
      }
      return "function other() { try { bar(); } catch(e) { console.warn(e); } }";
    });

    await checkFault(kv, graph, reporter, 50, makeRng(), "/tmp/mirrors");

    // Recall loop should produce passes, no fails for the unflagged file
    expect(reporter.counts.fail).toBe(0);
  });
});

// ─── checkBlastRadius ───────────────────────────────────────

describe("checkBlastRadius", () => {
  let kv: InMemoryKVStore;
  let graph: InMemoryGraphStore;
  let reporter: ValidationReporter;

  beforeEach(() => {
    resetCaches();
    kv = new InMemoryKVStore();
    graph = new InMemoryGraphStore();
    reporter = new ValidationReporter();
  });

  it("passes when flagged module is in PageRank top-10", async () => {
    // Build a hub: src/core.ts is imported by many files => highest PageRank.
    // All nodes (src/core.ts + a-e) will appear in top-10.
    // Seed findings for every node so the recall loop also passes.
    // Node IDs use "repo:path" format matching the real indexing pipeline (makeFileId).
    const edges = [
      { source: "repo1:src/a.ts", target: "repo1:src/core.ts", kind: "imports" as const, metadata: { repo: "repo1" } },
      { source: "repo1:src/b.ts", target: "repo1:src/core.ts", kind: "imports" as const, metadata: { repo: "repo1" } },
      { source: "repo1:src/c.ts", target: "repo1:src/core.ts", kind: "imports" as const, metadata: { repo: "repo1" } },
      { source: "repo1:src/d.ts", target: "repo1:src/core.ts", kind: "imports" as const, metadata: { repo: "repo1" } },
      { source: "repo1:src/e.ts", target: "repo1:src/core.ts", kind: "imports" as const, metadata: { repo: "repo1" } },
    ];
    await graph.addEdges(edges);

    // Flag all 6 nodes that will appear in PageRank results
    const allNodes = ["repo1:src/core.ts", "repo1:src/a.ts", "repo1:src/b.ts", "repo1:src/c.ts", "repo1:src/d.ts", "repo1:src/e.ts"];
    const findings = allNodes.map((node) => ({
      ruleId: "structural/high-pagerank",
      level: "warning",
      message: { text: "High blast radius" },
      locations: [{ logicalLocations: [{ fullyQualifiedName: node }] }],
    }));
    await kv.set("sarif:blastRadius:repo1", JSON.stringify(findings));

    await checkBlastRadius(kv, graph, reporter, 50, makeRng());

    expect(reporter.counts.fail).toBe(0);
    expect(reporter.counts.pass).toBeGreaterThanOrEqual(1);
  });

  it("fails when flagged module is NOT in PageRank top-10", async () => {
    // Graph of 3 nodes; src/leaf.ts is not in this graph at all.
    // repo stored in metadata so InMemoryGraphStore can filter correctly.
    // Node IDs use "repo:path" format matching the real indexing pipeline.
    await graph.addEdges([
      { source: "repo1:src/a.ts", target: "repo1:src/b.ts", kind: "imports" as const, metadata: { repo: "repo1" } },
      { source: "repo1:src/b.ts", target: "repo1:src/c.ts", kind: "imports" as const, metadata: { repo: "repo1" } },
    ]);

    // Flag repo1:src/leaf.ts which is not in the graph — cannot be in top-10
    const findings = [
      {
        ruleId: "structural/high-pagerank",
        level: "warning",
        message: { text: "High blast radius" },
        locations: [{ logicalLocations: [{ fullyQualifiedName: "repo1:src/leaf.ts" }] }],
      },
    ];
    await kv.set("sarif:blastRadius:repo1", JSON.stringify(findings));

    await checkBlastRadius(kv, graph, reporter, 50, makeRng());

    // Precision: src/leaf.ts not in top-10 => fail. (Recall may also contribute fails.)
    expect(reporter.counts.fail).toBeGreaterThanOrEqual(1);
  });

  it("skips when there are no blast radius findings", async () => {
    await checkBlastRadius(kv, graph, reporter, 50, makeRng());

    expect(reporter.counts.skip).toBeGreaterThanOrEqual(1);
    expect(reporter.counts.pass).toBe(0);
    expect(reporter.counts.fail).toBe(0);
  });
});

// ─── validateCommand output formats ─────────────────────────

describe("validateCommand output formats", () => {
  async function makeStores() {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();

    // Minimal SDP finding with correct threshold so consistency check passes
    const findings = [
      {
        ruleId: "structural/unstable-dependency",
        level: "warning",
        message: { text: "src/a.ts (I=0.20) depends on src/b.ts (I=0.80): threshold=0.3" },
        locations: [{ logicalLocations: [{ fullyQualifiedName: "src/a.ts->src/b.ts" }] }],
      },
    ];
    await kv.set("sarif:instability:repo1", JSON.stringify(findings));

    await graph.addEdges([
      { source: "src/a.ts", target: "src/b.ts", kind: "imports" as const, metadata: { repo: "repo1" } },
    ]);

    return { kv, graph };
  }

  it("json format produces valid parseable JSON with expected structure", async () => {
    const { kv, graph } = await makeStores();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => { logs.push(s); };

    try {
      const result = await validateCommand({
        kvStore: kv,
        graphStore: graph,
        format: "json",
        seed: 1,
      });

      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed).toHaveProperty("summary");
      expect(parsed).toHaveProperty("checks");
      expect(parsed).toHaveProperty("failures");
      expect(parsed.summary).toHaveProperty("total");
      expect(result).toMatchObject({ summary: expect.any(Object) });
    } finally {
      console.log = origLog;
    }
  });

  it("table format contains 'Validation Summary'", async () => {
    const { kv, graph } = await makeStores();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => { logs.push(s); };

    try {
      await validateCommand({
        kvStore: kv,
        graphStore: graph,
        format: "table",
        seed: 1,
      });
      expect(logs.join("\n")).toContain("Validation Summary");
    } finally {
      console.log = origLog;
    }
  });

  it("markdown format contains '## Validation Summary'", async () => {
    const { kv, graph } = await makeStores();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => { logs.push(s); };

    try {
      await validateCommand({
        kvStore: kv,
        graphStore: graph,
        format: "markdown",
        seed: 1,
      });
      expect(logs.join("\n")).toContain("## Validation Summary");
    } finally {
      console.log = origLog;
    }
  });
});
