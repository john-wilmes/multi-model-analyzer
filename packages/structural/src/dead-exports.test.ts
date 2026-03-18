import { describe, it, expect } from "vitest";
import { makeFileId } from "@mma/core";
import { detectDeadExports } from "./dead-exports.js";
import type { GraphEdge, ParsedFile, SymbolInfo } from "@mma/core";

function sym(name: string, kind: SymbolInfo["kind"], exported = true): SymbolInfo {
  return { name, kind, startLine: 1, endLine: 5, exported };
}

function pf(path: string, symbols: SymbolInfo[]): ParsedFile {
  return { path, repo: "test", kind: "typescript", symbols, errors: [], contentHash: "abc" };
}

function importEdge(source: string, target: string): GraphEdge {
  return { source, target, kind: "imports", metadata: { repo: "test" } };
}

describe("detectDeadExports", () => {
  it("flags exported symbols in files with no incoming import edges", () => {
    const files = [
      pf("orphan.ts", [sym("OrphanClass", "class"), sym("helperFn", "function")]),
    ];
    const results = detectDeadExports(files, [], "test");

    // One result per file, listing all dead exports
    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("structural/dead-export");
    expect(results[0]!.level).toBe("note");
    expect(results[0]!.message.text).toContain("OrphanClass");
    expect(results[0]!.message.text).toContain("helperFn");
    expect(results[0]!.message.text).toContain("2 dead export(s)");
  });

  it("does not flag files that are imported by at least one other file", () => {
    const files = [
      pf("used.ts", [sym("UsedClass", "class")]),
      pf("consumer.ts", [sym("main", "function")]),
    ];
    // Edge targets use canonical IDs (makeFileId) as produced by extractDependencyGraph
    const edges = [importEdge(makeFileId("test", "consumer.ts"), makeFileId("test", "used.ts"))];
    const results = detectDeadExports(files, edges, "test");

    // consumer.ts is not imported either, but it exports -> flagged
    // used.ts is imported -> not flagged
    const flaggedPaths = results.map((r) =>
      r.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName,
    );
    expect(flaggedPaths).not.toContain("used.ts");
    expect(flaggedPaths).toContain("consumer.ts");
  });

  it("does not flag entry point files even without consumers", () => {
    const files = [
      pf("index.ts", [sym("bootstrap", "function")]),
    ];
    const entryPoints = new Set(["index.ts"]);
    const results = detectDeadExports(files, [], "test", { entryPoints });

    expect(results).toHaveLength(0);
  });

  it("skips files with no exported symbols", () => {
    const files = [
      pf("internal.ts", [sym("privateFn", "function", false)]),
    ];
    const results = detectDeadExports(files, [], "test");
    expect(results).toHaveLength(0);
  });

  it("returns empty for empty input", () => {
    const results = detectDeadExports([], [], "test");
    expect(results).toHaveLength(0);
  });

  it("includes repo in SARIF location properties", () => {
    const files: ParsedFile[] = [
      { path: "orphan.ts", repo: "my-repo", kind: "typescript", symbols: [sym("Foo", "class")], errors: [], contentHash: "abc" },
    ];
    const results = detectDeadExports(files, [], "my-repo");

    expect(results[0]!.locations?.[0]?.logicalLocations?.[0]?.properties?.["repo"]).toBe("my-repo");
  });

  it("only flags exports matching the target repo", () => {
    const files = [
      pf("orphan.ts", [sym("Foo", "class")]),
      { path: "other.ts", repo: "other-repo", kind: "typescript" as const, symbols: [sym("Bar", "class")], errors: [], contentHash: "abc" } satisfies ParsedFile,
    ];
    const results = detectDeadExports(files, [], "test");
    // Only orphan.ts (repo="test") should be flagged, not other.ts (repo="other-repo")
    expect(results).toHaveLength(1);
    expect(results[0]!.message.text).toContain("orphan.ts");
  });

  it("file with mix of exported and non-exported symbols only flags exported ones", () => {
    const files = [
      pf("mixed.ts", [
        sym("PublicFn", "function", true),
        sym("privateFn", "function", false),
        sym("PublicClass", "class", true),
      ]),
    ];
    const results = detectDeadExports(files, [], "test");
    // One result per file; message lists only the 2 exported symbols
    expect(results).toHaveLength(1);
    const text = results[0]!.message.text;
    expect(text).toContain("2 dead export(s)");
    expect(text).toContain("PublicFn");
    expect(text).toContain("PublicClass");
    expect(text).not.toContain("privateFn");
  });

  it("does not flag file if imported via edge from different repo without repo metadata", () => {
    const files = [pf("lib.ts", [sym("Util", "function")])];
    // Edge without repo metadata should still count as an import;
    // target uses canonical ID as produced by extractDependencyGraph
    const edges: GraphEdge[] = [
      { source: "consumer.ts", target: makeFileId("test", "lib.ts"), kind: "imports", metadata: {} },
    ];
    const results = detectDeadExports(files, edges, "test");
    expect(results).toHaveLength(0); // Edge with no repo metadata → not filtered
  });

  it("ignores non-import edge kinds", () => {
    const files = [pf("lib.ts", [sym("Util", "function")])];
    const edges: GraphEdge[] = [
      { source: "consumer.ts", target: "lib.ts", kind: "calls", metadata: { repo: "test" } },
    ];
    const results = detectDeadExports(files, edges, "test");
    // "calls" edge should not count as an import → lib.ts still flagged (one result for the file)
    expect(results).toHaveLength(1);
    expect(results[0]!.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName).toBe("lib.ts");
  });

  it("import edge from different repo does not clear dead export", () => {
    const files = [pf("lib.ts", [sym("Util", "function")])];
    const edges: GraphEdge[] = [
      { source: "external.ts", target: "lib.ts", kind: "imports", metadata: { repo: "other-repo" } },
    ];
    const results = detectDeadExports(files, edges, "test");
    // Edge repo="other-repo" doesn't match target repo="test" → still flagged
    expect(results).toHaveLength(1);
  });

  it("multiple entry points are all excluded", () => {
    const files = [
      pf("index.ts", [sym("main", "function")]),
      pf("cli.ts", [sym("run", "function")]),
      pf("orphan.ts", [sym("unused", "function")]),
    ];
    const entryPoints = new Set(["index.ts", "cli.ts"]);
    const results = detectDeadExports(files, [], "test", { entryPoints });
    expect(results).toHaveLength(1);
    expect(results[0]!.message.text).toContain("orphan.ts");
  });
});
