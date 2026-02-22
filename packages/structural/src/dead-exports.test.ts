import { describe, it, expect } from "vitest";
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

    expect(results).toHaveLength(2);
    expect(results[0]!.ruleId).toBe("structural/dead-export");
    expect(results[0]!.level).toBe("note");
    expect(results[0]!.message.text).toContain("OrphanClass");
    expect(results[1]!.message.text).toContain("helperFn");
  });

  it("does not flag files that are imported by at least one other file", () => {
    const files = [
      pf("used.ts", [sym("UsedClass", "class")]),
      pf("consumer.ts", [sym("main", "function")]),
    ];
    const edges = [importEdge("consumer.ts", "used.ts")];
    const results = detectDeadExports(files, edges, "test");

    // consumer.ts is not imported either, but it exports -> flagged
    // used.ts is imported -> not flagged
    const flaggedPaths = results.map((r) =>
      r.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName,
    );
    expect(flaggedPaths).not.toContain("used.ts#UsedClass");
    expect(flaggedPaths).toContain("consumer.ts#main");
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
    const files = [pf("orphan.ts", [sym("Foo", "class")])];
    const results = detectDeadExports(files, [], "my-repo");

    expect(results[0]!.locations?.[0]?.logicalLocations?.[0]?.properties?.["repo"]).toBe("my-repo");
  });
});
