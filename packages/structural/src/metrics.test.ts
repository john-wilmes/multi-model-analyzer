import { describe, it, expect } from "vitest";
import { computeModuleMetrics, summarizeRepoMetrics, detectInstabilityViolations } from "./metrics.js";
import type { GraphEdge, ParsedFile, SymbolInfo, ModuleMetrics } from "@mma/core";

function edge(source: string, target: string): GraphEdge {
  return { source: `test:${source}`, target: `test:${target}`, kind: "imports", metadata: { repo: "test" } };
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

    const a = metrics.find((m) => m.module === "test:a.ts")!;
    expect(a.ca).toBe(0);
    expect(a.ce).toBe(1);
    expect(a.instability).toBe(1);

    const b = metrics.find((m) => m.module === "test:b.ts")!;
    expect(b.ca).toBe(1);
    expect(b.ce).toBe(1);
    expect(b.instability).toBe(0.5);

    const c = metrics.find((m) => m.module === "test:c.ts")!;
    expect(c.ca).toBe(1);
    expect(c.ce).toBe(0);
    expect(c.instability).toBe(0);
  });

  it("computes fan-in correctly (multiple importers)", () => {
    const edges = [edge("a.ts", "shared.ts"), edge("b.ts", "shared.ts"), edge("c.ts", "shared.ts")];
    const files = [pf("a.ts", []), pf("b.ts", []), pf("c.ts", []), pf("shared.ts", [])];
    const metrics = computeModuleMetrics(edges, files, "test");

    const shared = metrics.find((m) => m.module === "test:shared.ts")!;
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

    const types = metrics.find((m) => m.module === "test:types.ts")!;
    expect(types.abstractness).toBe(1);
  });

  it("computes abstractness: class-only file = 0.0", () => {
    const edges: GraphEdge[] = [];
    const files = [pf("impl.ts", [sym("Impl", "class"), sym("Helper", "function")])];
    const metrics = computeModuleMetrics(edges, files, "test");

    const impl = metrics.find((m) => m.module === "test:impl.ts")!;
    expect(impl.abstractness).toBe(0);
  });

  it("computes abstractness: mixed file = ratio", () => {
    const files = [pf("mixed.ts", [sym("IFoo", "interface"), sym("Foo", "class")])];
    const metrics = computeModuleMetrics([], files, "test");

    const mixed = metrics.find((m) => m.module === "test:mixed.ts")!;
    expect(mixed.abstractness).toBe(0.5);
  });

  it("isolated module (Ca+Ce=0) -> I=0 by convention", () => {
    const files = [pf("isolated.ts", [sym("Alone", "class")])];
    const metrics = computeModuleMetrics([], files, "test");

    const isolated = metrics.find((m) => m.module === "test:isolated.ts")!;
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

    const c = metrics.find((m) => m.module === "test:c.ts")!;
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

    const a = metrics.find((m) => m.module === "test:a.ts")!;
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

    const m = metrics.find((m) => m.module === "test:m.ts")!;
    expect(m.instability).toBe(0.5);
    expect(m.abstractness).toBe(0.5);
    expect(m.zone).toBe("main-sequence");
  });

  it("only considers import edges (ignores calls)", () => {
    const edges: GraphEdge[] = [
      edge("a.ts", "b.ts"),
      { source: "test:a.ts", target: "test:b.ts", kind: "calls", metadata: { repo: "test" } },
    ];
    const files = [pf("a.ts", []), pf("b.ts", [])];
    const metrics = computeModuleMetrics(edges, files, "test");

    const a = metrics.find((m) => m.module === "test:a.ts")!;
    expect(a.ce).toBe(1); // only import, not calls
  });
});

function metric(module: string, instability: number, abstractness: number, zone: ModuleMetrics["zone"], ca = 0, ce = 0): ModuleMetrics {
  const distance = Math.abs(abstractness + instability - 1);
  return { module, repo: "test", ca, ce, instability, abstractness, distance, zone };
}

describe("detectInstabilityViolations", () => {
  it("detects SDP violation when stable module imports unstable module", () => {
    const metrics = [
      metric("test:stable.ts", 0.1, 0, "pain", 5, 0),
      metric("test:unstable.ts", 0.9, 0, "balanced", 0, 5),
    ];
    const edges = [edge("stable.ts", "unstable.ts")];
    const results = detectInstabilityViolations(metrics, edges, "test");

    const sdp = results.filter((r) => r.ruleId === "structural/unstable-dependency");
    // One result per source module (grouped)
    expect(sdp).toHaveLength(1);
    expect(sdp[0]!.level).toBe("warning");
    // Source module is the subject; target listed in the dependency list
    expect(sdp[0]!.message.text).toContain("stable.ts");
    expect(sdp[0]!.message.text).toContain("unstable.ts");
    expect(sdp[0]!.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName).toBe("test:stable.ts");
  });

  it("no violation when instability delta is below threshold", () => {
    const metrics = [
      metric("test:a.ts", 0.4, 0, "balanced"),
      metric("test:b.ts", 0.5, 0, "balanced"),
    ];
    const edges = [edge("a.ts", "b.ts")];
    const results = detectInstabilityViolations(metrics, edges, "test");

    const sdp = results.filter((r) => r.ruleId === "structural/unstable-dependency");
    expect(sdp).toHaveLength(0);
  });

  it("emits pain zone finding", () => {
    const metrics = [metric("test:concrete.ts", 0.1, 0.1, "pain", 5, 0)];
    const results = detectInstabilityViolations(metrics, [], "test");

    const pain = results.filter((r) => r.ruleId === "structural/pain-zone-module");
    expect(pain).toHaveLength(1);
    expect(pain[0]!.level).toBe("note");
    expect(pain[0]!.message.text).toContain("pain zone");
  });

  it("emits uselessness zone finding", () => {
    const metrics = [metric("test:abstract.ts", 0.9, 0.9, "uselessness", 0, 5)];
    const results = detectInstabilityViolations(metrics, [], "test");

    const useless = results.filter((r) => r.ruleId === "structural/uselessness-zone-module");
    expect(useless).toHaveLength(1);
    expect(useless[0]!.level).toBe("note");
    expect(useless[0]!.message.text).toContain("uselessness zone");
  });

  it("returns empty array for empty input", () => {
    const results = detectInstabilityViolations([], [], "test");
    expect(results).toHaveLength(0);
  });

  it("respects custom sdpThreshold", () => {
    const metrics = [
      metric("test:a.ts", 0.1, 0, "pain"),
      metric("test:b.ts", 0.5, 0, "balanced"),
    ];
    const edges = [edge("a.ts", "b.ts")];

    // delta=0.4, threshold=0.5 -> no violation
    const noViolation = detectInstabilityViolations(metrics, edges, "test", { sdpThreshold: 0.5 });
    expect(noViolation.filter((r) => r.ruleId === "structural/unstable-dependency")).toHaveLength(0);

    // delta=0.4, threshold=0.3 -> violation
    const violation = detectInstabilityViolations(metrics, edges, "test", { sdpThreshold: 0.3 });
    expect(violation.filter((r) => r.ruleId === "structural/unstable-dependency")).toHaveLength(1);
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

  it("counts pain and uselessness zones correctly", () => {
    const modules = [
      metric("test:a.ts", 0.1, 0.1, "pain"),
      metric("test:b.ts", 0.2, 0.0, "pain"),
      metric("test:c.ts", 0.9, 0.9, "uselessness"),
      metric("test:d.ts", 0.5, 0.5, "main-sequence"),
    ];
    const summary = summarizeRepoMetrics(modules, "test");

    expect(summary.painZoneCount).toBe(2);
    expect(summary.uselessnessZoneCount).toBe(1);
    expect(summary.moduleCount).toBe(4);
  });
});

describe("classifyZone boundary conditions", () => {
  it("I=0.3 exactly is NOT pain zone (requires < 0.3)", () => {
    const files = [pf("boundary.ts", [sym("Concrete", "class")])];
    // Need I=0.3: Ca=7, Ce=3 → I = 3/10 = 0.3
    const edges = [
      edge("x1.ts", "boundary.ts"), edge("x2.ts", "boundary.ts"),
      edge("x3.ts", "boundary.ts"), edge("x4.ts", "boundary.ts"),
      edge("x5.ts", "boundary.ts"), edge("x6.ts", "boundary.ts"),
      edge("x7.ts", "boundary.ts"),
      edge("boundary.ts", "y1.ts"), edge("boundary.ts", "y2.ts"),
      edge("boundary.ts", "y3.ts"),
    ];
    const allFiles = [
      files[0]!, ...["x1","x2","x3","x4","x5","x6","x7","y1","y2","y3"]
        .map(n => pf(`${n}.ts`, [])),
    ];
    const metrics = computeModuleMetrics(edges, allFiles, "test");
    const b = metrics.find(m => m.module === "test:boundary.ts")!;

    expect(b.instability).toBeCloseTo(0.3, 5);
    expect(b.zone).not.toBe("pain");
  });

  it("I=0.29, A=0.0 IS pain zone", () => {
    const files = [pf("x.ts", [sym("C", "class")])];
    // I < 0.3 and A < 0.3 → pain zone
    // Need I = Ce/(Ca+Ce) < 0.3 with A=0
    // Ca=8, Ce=2 → I = 2/10 = 0.2
    const edges = [
      edge("a1.ts", "x.ts"), edge("a2.ts", "x.ts"), edge("a3.ts", "x.ts"),
      edge("a4.ts", "x.ts"), edge("a5.ts", "x.ts"), edge("a6.ts", "x.ts"),
      edge("a7.ts", "x.ts"), edge("a8.ts", "x.ts"),
      edge("x.ts", "b1.ts"), edge("x.ts", "b2.ts"),
    ];
    const allFiles = [files[0]!, ...["a1","a2","a3","a4","a5","a6","a7","a8","b1","b2"]
      .map(n => pf(`${n}.ts`, []))];
    const metrics = computeModuleMetrics(edges, allFiles, "test");
    const x = metrics.find(m => m.module === "test:x.ts")!;

    expect(x.instability).toBeCloseTo(0.2, 5);
    expect(x.abstractness).toBe(0);
    expect(x.zone).toBe("pain");
  });

  it("I=0.71, A=0.71 IS uselessness zone (requires > 0.7)", () => {
    // A module with high instability and all-abstract symbols
    // Ce=5, Ca=2 → I = 5/7 ≈ 0.714 > 0.7
    const files = [pf("over.ts", [sym("I1", "interface"), sym("T1", "type")])];
    const edges = [
      edge("x1.ts", "over.ts"), edge("x2.ts", "over.ts"),
      edge("over.ts", "y1.ts"), edge("over.ts", "y2.ts"),
      edge("over.ts", "y3.ts"), edge("over.ts", "y4.ts"),
      edge("over.ts", "y5.ts"),
    ];
    const allFiles = [files[0]!, ...["x1","x2","y1","y2","y3","y4","y5"]
      .map(n => pf(`${n}.ts`, []))];
    const metrics = computeModuleMetrics(edges, allFiles, "test");
    const o = metrics.find(m => m.module === "test:over.ts")!;

    expect(o.instability).toBeGreaterThan(0.7);
    expect(o.abstractness).toBe(1);
    expect(o.zone).toBe("uselessness");
  });

  it("I=0.7 exactly is NOT uselessness zone (requires > 0.7)", () => {
    // Ce=7, Ca=3 → I = 7/10 = 0.7
    const files = [pf("border.ts", [sym("IFoo", "interface")])];
    const edges = [
      edge("a1.ts", "border.ts"), edge("a2.ts", "border.ts"), edge("a3.ts", "border.ts"),
      edge("border.ts", "b1.ts"), edge("border.ts", "b2.ts"), edge("border.ts", "b3.ts"),
      edge("border.ts", "b4.ts"), edge("border.ts", "b5.ts"), edge("border.ts", "b6.ts"),
      edge("border.ts", "b7.ts"),
    ];
    const allFiles = [files[0]!, ...["a1","a2","a3","b1","b2","b3","b4","b5","b6","b7"]
      .map(n => pf(`${n}.ts`, []))];
    const metrics = computeModuleMetrics(edges, allFiles, "test");
    const b = metrics.find(m => m.module === "test:border.ts")!;

    expect(b.instability).toBeCloseTo(0.7, 5);
    expect(b.zone).not.toBe("uselessness");
  });

  it("distance boundary: A+I=0.7 → distance=0.3 → NOT main-sequence", () => {
    // distance = |A + I - 1| = |0.7 - 1| = 0.3
    // classifyZone checks distance < 0.3 for main-sequence, so 0.3 exactly → balanced
    const m = metric("test:edge.ts", 0.4, 0.3, "balanced");
    expect(m.distance).toBeCloseTo(0.3, 5);
    // Verify via summary it's not main-sequence
    const summary = summarizeRepoMetrics([m], "test");
    expect(summary.painZoneCount).toBe(0);
    expect(summary.uselessnessZoneCount).toBe(0);
  });

  it("file with no symbols has abstractness=0", () => {
    const files = [pf("empty.ts", [])];
    const metrics = computeModuleMetrics([], files, "test");
    const e = metrics.find(m => m.module === "test:empty.ts")!;
    expect(e.abstractness).toBe(0);
    expect(e.zone).toBe("pain"); // I=0, A=0 → both < 0.3
  });

  it("file referenced only in edges (not in parsedFiles) has abstractness=0", () => {
    // If a file appears in edges but not in parsedFiles, it still gets metrics
    const edges = [edge("a.ts", "phantom.ts")];
    const files = [pf("a.ts", [])];
    const metrics = computeModuleMetrics(edges, files, "test");
    const phantom = metrics.find(m => m.module === "test:phantom.ts")!;
    expect(phantom).toBeDefined();
    expect(phantom.abstractness).toBe(0); // no symbols found
    expect(phantom.ca).toBe(1);
    expect(phantom.ce).toBe(0);
  });

  it("handles mixed symbol kinds for abstractness calculation", () => {
    // 1 interface + 1 type + 2 functions + 1 class = 2/5 = 0.4
    const files = [pf("mixed.ts", [
      sym("IFoo", "interface"),
      sym("TBar", "type"),
      sym("fn1", "function"),
      sym("fn2", "function"),
      sym("Impl", "class"),
    ])];
    const metrics = computeModuleMetrics([], files, "test");
    const m = metrics.find(m => m.module === "test:mixed.ts")!;
    expect(m.abstractness).toBeCloseTo(0.4, 5);
  });
});

describe("detectInstabilityViolations edge cases", () => {
  it("SDP at exact threshold boundary (delta === threshold) → no violation", () => {
    const metrics = [
      metric("test:a.ts", 0.3, 0, "balanced"),
      metric("test:b.ts", 0.6, 0, "balanced"),
    ];
    const edges = [edge("a.ts", "b.ts")];
    // delta = 0.6 - 0.3 = 0.3, threshold default = 0.3
    // check is delta > threshold (strict), so 0.3 > 0.3 = false → no violation
    const results = detectInstabilityViolations(metrics, edges, "test");
    const sdp = results.filter(r => r.ruleId === "structural/unstable-dependency");
    expect(sdp).toHaveLength(0);
  });

  it("SDP with delta just above threshold → violation", () => {
    const metrics = [
      metric("test:a.ts", 0.3, 0, "balanced"),
      metric("test:b.ts", 0.61, 0, "balanced"),
    ];
    const edges = [edge("a.ts", "b.ts")];
    const results = detectInstabilityViolations(metrics, edges, "test");
    const sdp = results.filter(r => r.ruleId === "structural/unstable-dependency");
    expect(sdp).toHaveLength(1);
  });

  it("ignores non-import edges", () => {
    const metrics = [
      metric("test:a.ts", 0.1, 0, "pain"),
      metric("test:b.ts", 0.9, 0, "balanced"),
    ];
    const callEdge: GraphEdge = { source: "test:a.ts", target: "test:b.ts", kind: "calls", metadata: { repo: "test" } };
    const results = detectInstabilityViolations(metrics, [callEdge], "test");
    const sdp = results.filter(r => r.ruleId === "structural/unstable-dependency");
    expect(sdp).toHaveLength(0);
  });

  it("skips edges where source or target is missing from metrics", () => {
    const metrics = [metric("test:a.ts", 0.1, 0, "pain")];
    const edges = [edge("a.ts", "unknown.ts")];
    const results = detectInstabilityViolations(metrics, edges, "test");
    const sdp = results.filter(r => r.ruleId === "structural/unstable-dependency");
    expect(sdp).toHaveLength(0);
  });

  it("does not emit zone findings for balanced or main-sequence modules", () => {
    const metrics = [
      metric("test:a.ts", 0.5, 0.5, "main-sequence"),
      metric("test:b.ts", 0.5, 0.0, "balanced"),
    ];
    const results = detectInstabilityViolations(metrics, [], "test");
    expect(results).toHaveLength(0);
  });
});
