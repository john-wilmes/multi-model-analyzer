import { describe, it, expect } from "vitest";
import { computeModuleMetrics, summarizeRepoMetrics } from "./metrics.js";
import type { GraphEdge, ParsedFile, SymbolInfo } from "@mma/core";

function edge(source: string, target: string): GraphEdge {
  return { source, target, kind: "imports", metadata: { repo: "test" } };
}

function sym(name: string, kind: SymbolInfo["kind"]): SymbolInfo {
  return { name, kind, startLine: 1, endLine: 5, exported: true };
}

function pf(path: string, symbols: SymbolInfo[]): ParsedFile {
  return { path, repo: "test", kind: "typescript", symbols, errors: [], contentHash: "abc" };
}

describe("computeModuleMetrics", () => {
  it("computes Ca and Ce for a simple chain (A -> B -> C)", () => {
    const edges = [edge("a.ts", "b.ts"), edge("b.ts", "c.ts")];
    const files = [pf("a.ts", []), pf("b.ts", []), pf("c.ts", [])];
    const metrics = computeModuleMetrics(edges, files, "test");

    const a = metrics.find((m) => m.module === "a.ts")!;
    expect(a.ca).toBe(0);
    expect(a.ce).toBe(1);
    expect(a.instability).toBe(1);

    const b = metrics.find((m) => m.module === "b.ts")!;
    expect(b.ca).toBe(1);
    expect(b.ce).toBe(1);
    expect(b.instability).toBe(0.5);

    const c = metrics.find((m) => m.module === "c.ts")!;
    expect(c.ca).toBe(1);
    expect(c.ce).toBe(0);
    expect(c.instability).toBe(0);
  });

  it("computes fan-in correctly (multiple importers)", () => {
    const edges = [edge("a.ts", "shared.ts"), edge("b.ts", "shared.ts"), edge("c.ts", "shared.ts")];
    const files = [pf("a.ts", []), pf("b.ts", []), pf("c.ts", []), pf("shared.ts", [])];
    const metrics = computeModuleMetrics(edges, files, "test");

    const shared = metrics.find((m) => m.module === "shared.ts")!;
    expect(shared.ca).toBe(3);
    expect(shared.ce).toBe(0);
    expect(shared.instability).toBe(0);
  });

  it("computes abstractness: interface-only file = 1.0", () => {
    const edges = [edge("a.ts", "types.ts")];
    const files = [
      pf("a.ts", [sym("Foo", "class")]),
      pf("types.ts", [sym("Bar", "interface"), sym("Baz", "type")]),
    ];
    const metrics = computeModuleMetrics(edges, files, "test");

    const types = metrics.find((m) => m.module === "types.ts")!;
    expect(types.abstractness).toBe(1);
  });

  it("computes abstractness: class-only file = 0.0", () => {
    const edges: GraphEdge[] = [];
    const files = [pf("impl.ts", [sym("Impl", "class"), sym("Helper", "function")])];
    const metrics = computeModuleMetrics(edges, files, "test");

    const impl = metrics.find((m) => m.module === "impl.ts")!;
    expect(impl.abstractness).toBe(0);
  });

  it("computes abstractness: mixed file = ratio", () => {
    const files = [pf("mixed.ts", [sym("IFoo", "interface"), sym("Foo", "class")])];
    const metrics = computeModuleMetrics([], files, "test");

    const mixed = metrics.find((m) => m.module === "mixed.ts")!;
    expect(mixed.abstractness).toBe(0.5);
  });

  it("isolated module (Ca+Ce=0) -> I=0 by convention", () => {
    const files = [pf("isolated.ts", [sym("Alone", "class")])];
    const metrics = computeModuleMetrics([], files, "test");

    const isolated = metrics.find((m) => m.module === "isolated.ts")!;
    expect(isolated.instability).toBe(0);
    expect(isolated.ca).toBe(0);
    expect(isolated.ce).toBe(0);
  });

  it("classifies pain zone (low I, low A)", () => {
    // c.ts: high fan-in, no exports of abstractions -> pain zone
    const edges = [edge("a.ts", "c.ts"), edge("b.ts", "c.ts"), edge("d.ts", "c.ts"), edge("e.ts", "c.ts")];
    const files = [
      pf("a.ts", []), pf("b.ts", []), pf("c.ts", [sym("Concrete", "class")]),
      pf("d.ts", []), pf("e.ts", []),
    ];
    const metrics = computeModuleMetrics(edges, files, "test");

    const c = metrics.find((m) => m.module === "c.ts")!;
    expect(c.instability).toBe(0);
    expect(c.abstractness).toBe(0);
    expect(c.zone).toBe("pain");
  });

  it("classifies uselessness zone (high I, high A)", () => {
    // a.ts: imports lots, all symbols are abstract
    const edges = [edge("a.ts", "b.ts"), edge("a.ts", "c.ts"), edge("a.ts", "d.ts"), edge("a.ts", "e.ts")];
    const files = [
      pf("a.ts", [sym("IFoo", "interface"), sym("TBar", "type")]),
      pf("b.ts", []), pf("c.ts", []), pf("d.ts", []), pf("e.ts", []),
    ];
    const metrics = computeModuleMetrics(edges, files, "test");

    const a = metrics.find((m) => m.module === "a.ts")!;
    expect(a.instability).toBe(1);
    expect(a.abstractness).toBe(1);
    expect(a.zone).toBe("uselessness");
  });

  it("classifies main-sequence zone (A + I close to 1)", () => {
    // I=0.5, A=0.5 -> distance=0 -> main-sequence
    const edges = [edge("a.ts", "m.ts"), edge("m.ts", "b.ts")];
    const files = [
      pf("a.ts", []),
      pf("m.ts", [sym("IFoo", "interface"), sym("Impl", "class")]),
      pf("b.ts", []),
    ];
    const metrics = computeModuleMetrics(edges, files, "test");

    const m = metrics.find((m) => m.module === "m.ts")!;
    expect(m.instability).toBe(0.5);
    expect(m.abstractness).toBe(0.5);
    expect(m.zone).toBe("main-sequence");
  });

  it("only considers import edges (ignores calls)", () => {
    const edges: GraphEdge[] = [
      edge("a.ts", "b.ts"),
      { source: "a.ts", target: "b.ts", kind: "calls", metadata: { repo: "test" } },
    ];
    const files = [pf("a.ts", []), pf("b.ts", [])];
    const metrics = computeModuleMetrics(edges, files, "test");

    const a = metrics.find((m) => m.module === "a.ts")!;
    expect(a.ce).toBe(1); // only import, not calls
  });
});

describe("summarizeRepoMetrics", () => {
  it("aggregates module metrics", () => {
    const edges = [edge("a.ts", "b.ts"), edge("b.ts", "c.ts")];
    const files = [pf("a.ts", []), pf("b.ts", []), pf("c.ts", [sym("I", "interface")])];
    const metrics = computeModuleMetrics(edges, files, "test");
    const summary = summarizeRepoMetrics(metrics, "test");

    expect(summary.repo).toBe("test");
    expect(summary.moduleCount).toBe(3);
    expect(summary.avgInstability).toBeCloseTo((1 + 0.5 + 0) / 3, 5);
    expect(summary.avgAbstractness).toBeGreaterThanOrEqual(0);
    expect(summary.avgDistance).toBeGreaterThanOrEqual(0);
  });

  it("returns zeros for empty input", () => {
    const summary = summarizeRepoMetrics([], "empty");
    expect(summary.moduleCount).toBe(0);
    expect(summary.avgInstability).toBe(0);
    expect(summary.avgAbstractness).toBe(0);
    expect(summary.avgDistance).toBe(0);
    expect(summary.painZoneCount).toBe(0);
    expect(summary.uselessnessZoneCount).toBe(0);
  });
});
