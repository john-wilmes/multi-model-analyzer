import { describe, it, expect, vi } from "vitest";
import { InMemoryKVStore } from "@mma/storage";
import type { SarifLog, SarifResult } from "@mma/core";
import {
  deltaCommand,
  renderDeltaMarkdown,
  renderDeltaJson,
  renderDeltaSarif,
  type DeltaResult,
} from "./delta-cmd.js";

// ---------------------------------------------------------------------------
// Mock @mma/ingestion
// ---------------------------------------------------------------------------

vi.mock("@mma/ingestion", () => ({
  parseRevisionRange: (range: string) => {
    const idx = range.indexOf("..");
    if (idx >= 0) {
      return { from: range.slice(0, idx) || "HEAD", to: range.slice(idx + 2) || "HEAD" };
    }
    return { from: range, to: "HEAD" };
  },
  getChangedFilesInRange: vi.fn(),
}));

import { getChangedFilesInRange } from "@mma/ingestion";
const mockGetChanged = vi.mocked(getChangedFilesInRange);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BaselineState = "new" | "updated" | "unchanged" | "absent";

function makeSarifLog(
  results: Array<{
    ruleId: string;
    level?: "error" | "warning" | "note";
    message?: string;
    fqns?: string[];
    baselineState?: BaselineState;
  }>,
): SarifLog {
  return {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "mma", version: "0.1.0", rules: [] } },
        results: results.map((r) => ({
          ruleId: r.ruleId,
          level: r.level ?? "warning",
          baselineState: r.baselineState,
          message: { text: r.message ?? `Finding ${r.ruleId}` },
          locations:
            r.fqns && r.fqns.length > 0
              ? [
                  {
                    logicalLocations: r.fqns.map((fqn) => ({
                      fullyQualifiedName: fqn,
                      name: fqn.split("/").pop() ?? fqn,
                    })),
                  },
                ]
              : undefined,
        })),
      },
    ],
  };
}

async function seedSarif(
  kv: InMemoryKVStore,
  results: Parameters<typeof makeSarifLog>[0],
): Promise<void> {
  await kv.set("sarif:latest", JSON.stringify(makeSarifLog(results)));
}

const REPOS = [{ name: "my-repo", localPath: "/repos/my-repo" }];

// ---------------------------------------------------------------------------
// Tests: no SARIF data
// ---------------------------------------------------------------------------

describe("deltaCommand — no SARIF data", () => {
  it("returns empty result and prints message when sarif:latest is absent", async () => {
    const kv = new InMemoryKVStore();
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });

    const result = await deltaCommand({
      kvStore: kv,
      repos: REPOS,
      range: "main..HEAD",
      format: "markdown",
    });

    consoleSpy.mockRestore();

    expect(result.newFindings).toHaveLength(0);
    expect(result.updatedFindings).toHaveLength(0);
    expect(result.hasNewOrUpdated).toBe(false);
    expect(logs.some((l) => /no sarif data/i.test(l))).toBe(true);
  });

  it("returns empty result silently when silent=true", async () => {
    const kv = new InMemoryKVStore();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await deltaCommand({
      kvStore: kv,
      repos: REPOS,
      range: "main..HEAD",
      format: "markdown",
      silent: true,
    });

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tests: file path filtering
// ---------------------------------------------------------------------------

describe("deltaCommand — filters by changed files", () => {
  it("only includes findings matching changed files", async () => {
    const kv = new InMemoryKVStore();
    await seedSarif(kv, [
      {
        ruleId: "structural/dead-export",
        fqns: ["src/auth.ts"],
        baselineState: "new",
      },
      {
        ruleId: "fault/silent-failure",
        fqns: ["src/unrelated.ts"],
        baselineState: "new",
      },
    ]);

    mockGetChanged.mockResolvedValueOnce({
      from: "abc",
      to: "def",
      added: ["src/auth.ts"],
      modified: [],
      deleted: [],
    });

    const result = await deltaCommand({
      kvStore: kv,
      repos: REPOS,
      range: "main..HEAD",
      format: "markdown",
      silent: true,
    });

    // Only the finding for src/auth.ts (which was added) should appear
    expect(result.newFindings).toHaveLength(1);
    expect(result.newFindings[0]!.ruleId).toBe("structural/dead-export");
  });

  it("matches findings using substring matching (repo-prefixed fqn)", async () => {
    const kv = new InMemoryKVStore();
    await seedSarif(kv, [
      {
        ruleId: "structural/unstable-dependency",
        // fqn is repo-prefixed, diff path is plain
        fqns: ["my-repo/src/auth.ts"],
        baselineState: "new",
      },
    ]);

    mockGetChanged.mockResolvedValueOnce({
      from: "abc",
      to: "def",
      added: [],
      modified: ["src/auth.ts"],
      deleted: [],
    });

    const result = await deltaCommand({
      kvStore: kv,
      repos: REPOS,
      range: "main..HEAD",
      format: "markdown",
      silent: true,
    });

    expect(result.newFindings).toHaveLength(1);
  });

  it("includes findings on modified files in addition to added files", async () => {
    const kv = new InMemoryKVStore();
    await seedSarif(kv, [
      {
        ruleId: "fault/unhandled-error-path",
        fqns: ["src/api.ts"],
        baselineState: "updated",
      },
    ]);

    mockGetChanged.mockResolvedValueOnce({
      from: "abc",
      to: "def",
      added: [],
      modified: ["src/api.ts"],
      deleted: [],
    });

    const result = await deltaCommand({
      kvStore: kv,
      repos: REPOS,
      range: "main..HEAD",
      format: "markdown",
      silent: true,
    });

    expect(result.updatedFindings).toHaveLength(1);
    expect(result.updatedFindings[0]!.ruleId).toBe("fault/unhandled-error-path");
  });

  it("returns zero findings when no files match", async () => {
    const kv = new InMemoryKVStore();
    await seedSarif(kv, [
      {
        ruleId: "structural/dead-export",
        fqns: ["src/auth.ts"],
        baselineState: "new",
      },
    ]);

    mockGetChanged.mockResolvedValueOnce({
      from: "abc",
      to: "def",
      added: ["src/other.ts"],
      modified: [],
      deleted: [],
    });

    const result = await deltaCommand({
      kvStore: kv,
      repos: REPOS,
      range: "main..HEAD",
      format: "markdown",
      silent: true,
    });

    expect(result.newFindings).toHaveLength(0);
    expect(result.updatedFindings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: baselineState filtering
// ---------------------------------------------------------------------------

describe("deltaCommand — filters by baselineState", () => {
  it("only passes through new and updated findings, hides unchanged", async () => {
    const kv = new InMemoryKVStore();
    await seedSarif(kv, [
      {
        ruleId: "structural/dead-export",
        fqns: ["src/auth.ts"],
        baselineState: "new",
      },
      {
        ruleId: "fault/silent-failure",
        fqns: ["src/auth.ts"],
        baselineState: "updated",
      },
      {
        ruleId: "config/dead-flag",
        fqns: ["src/auth.ts"],
        baselineState: "unchanged",
      },
      {
        ruleId: "arch/layer-violation",
        fqns: ["src/auth.ts"],
        // no baselineState — treated as neither new nor updated
      },
    ]);

    mockGetChanged.mockResolvedValueOnce({
      from: "abc",
      to: "def",
      added: ["src/auth.ts"],
      modified: [],
      deleted: [],
    });

    const result = await deltaCommand({
      kvStore: kv,
      repos: REPOS,
      range: "main..HEAD",
      format: "markdown",
      silent: true,
    });

    expect(result.newFindings).toHaveLength(1);
    expect(result.newFindings[0]!.ruleId).toBe("structural/dead-export");
    expect(result.updatedFindings).toHaveLength(1);
    expect(result.updatedFindings[0]!.ruleId).toBe("fault/silent-failure");
    // unchanged and no-state findings are counted but hidden
    expect(result.unchangedCount).toBe(2);
  });

  it("counts absent findings as unchanged (they appear in sarif:latest with absent state)", async () => {
    const kv = new InMemoryKVStore();
    await seedSarif(kv, [
      {
        ruleId: "structural/dead-export",
        fqns: ["src/auth.ts"],
        baselineState: "absent",
      },
    ]);

    mockGetChanged.mockResolvedValueOnce({
      from: "abc",
      to: "def",
      added: ["src/auth.ts"],
      modified: [],
      deleted: [],
    });

    const result = await deltaCommand({
      kvStore: kv,
      repos: REPOS,
      range: "main..HEAD",
      format: "markdown",
      silent: true,
    });

    expect(result.newFindings).toHaveLength(0);
    expect(result.updatedFindings).toHaveLength(0);
    expect(result.unchangedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: markdown format
// ---------------------------------------------------------------------------

describe("renderDeltaMarkdown", () => {
  const baseResult: DeltaResult = {
    range: "main..HEAD",
    changedFiles: 12,
    addedFiles: 4,
    modifiedFiles: 8,
    newFindings: [],
    updatedFindings: [],
    unchangedCount: 5,
    hasNewOrUpdated: false,
  };

  it("renders header with change counts", () => {
    const md = renderDeltaMarkdown(baseResult, "main..HEAD");
    expect(md).toContain("## MMA Delta Analysis");
    expect(md).toContain("`main..HEAD`");
    expect(md).toContain("12");
    expect(md).toContain("8 modified");
    expect(md).toContain("4 added");
  });

  it("renders no-findings message when empty", () => {
    const md = renderDeltaMarkdown(baseResult, "main..HEAD");
    expect(md).toContain("No new or worsened findings.");
  });

  it("renders new findings table with severity, rule, message, file columns", () => {
    const result: DeltaResult = {
      ...baseResult,
      newFindings: [
        {
          ruleId: "structural/unstable-dependency",
          level: "warning",
          baselineState: "new",
          message: { text: "Stable module depends on unstable module (delta=0.45)" },
          locations: [
            {
              logicalLocations: [{ fullyQualifiedName: "src/auth.ts" }],
            },
          ],
        },
      ],
      hasNewOrUpdated: true,
    };

    const md = renderDeltaMarkdown(result, "main..HEAD");
    expect(md).toContain("### New Findings");
    expect(md).toContain("structural/unstable-dependency");
    expect(md).toContain("Stable module depends on unstable module");
    expect(md).toContain("src/auth.ts");
    expect(md).toContain("| Severity | Rule | Message | File |");
  });

  it("renders updated findings table", () => {
    const result: DeltaResult = {
      ...baseResult,
      updatedFindings: [
        {
          ruleId: "fault/unhandled-error-path",
          level: "warning",
          baselineState: "updated",
          message: { text: "Catch block with no logging" },
          locations: [
            {
              logicalLocations: [{ fullyQualifiedName: "src/api.ts" }],
            },
          ],
        },
      ],
      hasNewOrUpdated: true,
    };

    const md = renderDeltaMarkdown(result, "main..HEAD");
    expect(md).toContain("### Updated Findings");
    expect(md).toContain("fault/unhandled-error-path");
    expect(md).toContain("Catch block with no logging");
    expect(md).toContain("src/api.ts");
  });

  it("escapes pipe characters in messages", () => {
    const result: DeltaResult = {
      ...baseResult,
      newFindings: [
        {
          ruleId: "test/rule",
          level: "warning",
          baselineState: "new",
          message: { text: "foo | bar" },
          locations: undefined,
        },
      ],
      hasNewOrUpdated: true,
    };

    const md = renderDeltaMarkdown(result, "main..HEAD");
    expect(md).toContain("foo \\| bar");
  });
});

// ---------------------------------------------------------------------------
// Tests: JSON format
// ---------------------------------------------------------------------------

describe("renderDeltaJson", () => {
  it("returns array containing both new and updated findings", () => {
    const newF: SarifResult = {
      ruleId: "structural/dead-export",
      level: "note",
      baselineState: "new",
      message: { text: "dead export" },
    };
    const updatedF: SarifResult = {
      ruleId: "fault/silent-failure",
      level: "warning",
      baselineState: "updated",
      message: { text: "silent failure" },
    };

    const json = renderDeltaJson([newF], [updatedF]);
    const parsed = JSON.parse(json) as SarifResult[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.ruleId).toBe("structural/dead-export");
    expect(parsed[0]!.baselineState).toBe("new");
    expect(parsed[1]!.ruleId).toBe("fault/silent-failure");
    expect(parsed[1]!.baselineState).toBe("updated");
  });

  it("returns empty array when no findings", () => {
    const json = renderDeltaJson([], []);
    expect(JSON.parse(json)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: SARIF format
// ---------------------------------------------------------------------------

describe("renderDeltaSarif", () => {
  it("returns valid SARIF v2.1.0 log", () => {
    const f: SarifResult = {
      ruleId: "structural/dead-export",
      level: "note",
      baselineState: "new",
      message: { text: "dead export" },
    };

    const sarif = renderDeltaSarif([f], [], "main..HEAD");
    const log = JSON.parse(sarif) as { version: string; runs: unknown[] };
    expect(log.version).toBe("2.1.0");
    expect(log.runs).toHaveLength(1);
  });

  it("includes all findings in single run", () => {
    const newF: SarifResult = {
      ruleId: "structural/dead-export",
      level: "note",
      baselineState: "new",
      message: { text: "dead export" },
    };
    const updatedF: SarifResult = {
      ruleId: "fault/silent-failure",
      level: "warning",
      baselineState: "updated",
      message: { text: "silent failure" },
    };

    const sarif = renderDeltaSarif([newF], [updatedF], "main..HEAD");
    const log = JSON.parse(sarif) as {
      runs: Array<{ results: SarifResult[] }>;
    };
    expect(log.runs[0]!.results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: exit-code behavior
// ---------------------------------------------------------------------------

describe("deltaCommand — exit code behavior", () => {
  it("hasNewOrUpdated is true when new findings exist", async () => {
    const kv = new InMemoryKVStore();
    await seedSarif(kv, [
      {
        ruleId: "structural/dead-export",
        fqns: ["src/auth.ts"],
        baselineState: "new",
      },
    ]);

    mockGetChanged.mockResolvedValueOnce({
      from: "abc",
      to: "def",
      added: ["src/auth.ts"],
      modified: [],
      deleted: [],
    });

    const result = await deltaCommand({
      kvStore: kv,
      repos: REPOS,
      range: "main..HEAD",
      format: "markdown",
      silent: true,
    });

    expect(result.hasNewOrUpdated).toBe(true);
  });

  it("hasNewOrUpdated is true when updated findings exist", async () => {
    const kv = new InMemoryKVStore();
    await seedSarif(kv, [
      {
        ruleId: "fault/unhandled-error-path",
        fqns: ["src/api.ts"],
        baselineState: "updated",
      },
    ]);

    mockGetChanged.mockResolvedValueOnce({
      from: "abc",
      to: "def",
      added: [],
      modified: ["src/api.ts"],
      deleted: [],
    });

    const result = await deltaCommand({
      kvStore: kv,
      repos: REPOS,
      range: "main..HEAD",
      format: "markdown",
      silent: true,
    });

    expect(result.hasNewOrUpdated).toBe(true);
  });

  it("hasNewOrUpdated is false when only unchanged findings exist", async () => {
    const kv = new InMemoryKVStore();
    await seedSarif(kv, [
      {
        ruleId: "structural/dead-export",
        fqns: ["src/auth.ts"],
        baselineState: "unchanged",
      },
    ]);

    mockGetChanged.mockResolvedValueOnce({
      from: "abc",
      to: "def",
      added: ["src/auth.ts"],
      modified: [],
      deleted: [],
    });

    const result = await deltaCommand({
      kvStore: kv,
      repos: REPOS,
      range: "main..HEAD",
      format: "markdown",
      silent: true,
    });

    expect(result.hasNewOrUpdated).toBe(false);
  });

  it("hasNewOrUpdated is false when no changed files match any finding", async () => {
    const kv = new InMemoryKVStore();
    await seedSarif(kv, [
      {
        ruleId: "structural/dead-export",
        fqns: ["src/auth.ts"],
        baselineState: "new",
      },
    ]);

    mockGetChanged.mockResolvedValueOnce({
      from: "abc",
      to: "def",
      added: ["src/other.ts"],
      modified: [],
      deleted: [],
    });

    const result = await deltaCommand({
      kvStore: kv,
      repos: REPOS,
      range: "main..HEAD",
      format: "markdown",
      silent: true,
    });

    expect(result.hasNewOrUpdated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: multi-repo handling
// ---------------------------------------------------------------------------

describe("deltaCommand — multi-repo", () => {
  it("aggregates findings across multiple repos", async () => {
    const repos = [
      { name: "repo-a", localPath: "/repos/repo-a" },
      { name: "repo-b", localPath: "/repos/repo-b" },
    ];

    const kv = new InMemoryKVStore();
    await seedSarif(kv, [
      {
        ruleId: "structural/dead-export",
        fqns: ["src/a.ts"],
        baselineState: "new",
      },
      {
        ruleId: "fault/silent-failure",
        fqns: ["src/b.ts"],
        baselineState: "new",
      },
    ]);

    // repo-a has src/a.ts changed, repo-b has src/b.ts changed
    mockGetChanged
      .mockResolvedValueOnce({
        from: "abc",
        to: "def",
        added: ["src/a.ts"],
        modified: [],
        deleted: [],
      })
      .mockResolvedValueOnce({
        from: "abc",
        to: "def",
        added: ["src/b.ts"],
        modified: [],
        deleted: [],
      });

    const result = await deltaCommand({
      kvStore: kv,
      repos,
      range: "main..HEAD",
      format: "markdown",
      silent: true,
    });

    expect(result.newFindings).toHaveLength(2);
    expect(result.changedFiles).toBe(2);
  });

  it("skips repos where git diff fails and continues with others", async () => {
    const repos = [
      { name: "repo-a", localPath: "/repos/repo-a" },
      { name: "repo-b", localPath: "/repos/repo-b" },
    ];

    const kv = new InMemoryKVStore();
    await seedSarif(kv, [
      {
        ruleId: "structural/dead-export",
        fqns: ["src/b.ts"],
        baselineState: "new",
      },
    ]);

    // repo-a throws (bare repo or missing range), repo-b succeeds
    mockGetChanged
      .mockRejectedValueOnce(new Error("unknown revision"))
      .mockResolvedValueOnce({
        from: "abc",
        to: "def",
        added: ["src/b.ts"],
        modified: [],
        deleted: [],
      });

    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await deltaCommand({
      kvStore: kv,
      repos,
      range: "main..HEAD",
      format: "markdown",
      silent: false,
    });

    warnSpy.mockRestore();

    expect(result.newFindings).toHaveLength(1);
  });
});
