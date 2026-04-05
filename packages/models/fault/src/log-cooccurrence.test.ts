import { describe, it, expect } from "vitest";
import type { LogTemplateIndex, LogTemplate, CallGraph, LogicalLocation } from "@mma/core";
import type { BackwardTrace } from "./backward-trace.js";
import type { LogRoot } from "./log-roots.js";
import { analyzeLogCoOccurrence } from "./log-cooccurrence.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function loc(module: string, line: number): LogicalLocation {
  return { repo: "test-repo", module, fullyQualifiedName: `${module}:${line}` };
}

function tmpl(id: string, text: string, locs: LogicalLocation[]): LogTemplate {
  return { id, template: text, severity: "error", locations: locs, frequency: 1 };
}

function makeLogIndex(templates: LogTemplate[]): LogTemplateIndex {
  return { repo: "test-repo", templates };
}

function emptyCallGraph(): CallGraph {
  return { repo: "test-repo", edges: [], nodeCount: 0 };
}

function makeRoot(template: LogTemplate): LogRoot {
  return {
    id: `root-${template.id}`,
    template,
    severity: "high",
    context: "general",
    location: template.locations[0]!,
  };
}

function makeTrace(template: LogTemplate, edges: Array<{ from: string; to: string }> = []): BackwardTrace {
  return {
    root: makeRoot(template),
    steps: [],
    crossServiceCalls: [],
    tracedEdges: edges.map((e) => ({ ...e, condition: "test" })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("analyzeLogCoOccurrence", () => {
  it("groups templates in same file", () => {
    const a = tmpl("t1", "database query failed", [loc("src/db.ts", 10)]);
    const b = tmpl("t2", "database connection lost", [loc("src/db.ts", 50)]);
    const index = makeLogIndex([a, b]);
    const result = analyzeLogCoOccurrence(index, emptyCallGraph(), []);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.relationship).toBe("same-file");
    expect(result.groups[0]!.score).toBe(0.6);
    expect(result.groups[0]!.templates).toHaveLength(2);
  });

  it("assigns higher score to same-function pairs", () => {
    const a = tmpl("t1", "request failed", [loc("src/http.ts", 20)]);
    const b = tmpl("t2", "request timeout", [loc("src/http.ts", 30)]);
    const index = makeLogIndex([a, b]);
    const result = analyzeLogCoOccurrence(index, emptyCallGraph(), []);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.relationship).toBe("same-function");
    expect(result.groups[0]!.score).toBe(0.9);
  });

  it("groups call-graph connected templates", () => {
    const a = tmpl("t1", "handler failed", [loc("src/handler.ts", 10)]);
    const b = tmpl("t2", "service error", [loc("src/service.ts", 10)]);
    const index = makeLogIndex([a, b]);
    const callGraph: CallGraph = {
      repo: "test-repo",
      edges: [{ source: "src/handler.ts", target: "src/service.ts", kind: "calls" }],
      nodeCount: 2,
    };
    const result = analyzeLogCoOccurrence(index, callGraph, []);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.relationship).toBe("call-connected");
    expect(result.groups[0]!.score).toBe(0.4);
  });

  it("does not group unrelated templates", () => {
    const a = tmpl("t1", "handler failed", [loc("src/handler.ts", 10)]);
    const b = tmpl("t2", "mailer error", [loc("src/mailer.ts", 10)]);
    const index = makeLogIndex([a, b]);
    const result = analyzeLogCoOccurrence(index, emptyCallGraph(), []);

    expect(result.groups).toHaveLength(0);
  });

  it("skips duplicate template text", () => {
    const a = tmpl("t1", "connection failed", [loc("src/db.ts", 10)]);
    const b = tmpl("t2", "connection failed", [loc("src/db.ts", 15)]);
    const index = makeLogIndex([a, b]);
    const result = analyzeLogCoOccurrence(index, emptyCallGraph(), []);

    // Same text → skipped even though they're in same-function range
    expect(result.groups).toHaveLength(0);
  });

  it("detects trace overlap", () => {
    const a = tmpl("t1", "auth failed", [loc("src/auth.ts", 10)]);
    const b = tmpl("t2", "permission denied", [loc("src/perm.ts", 10)]);
    const index = makeLogIndex([a, b]);

    // Give both traces 4 common edges out of 5 total → 80% overlap
    const sharedEdges = [
      { from: "n1", to: "n2" },
      { from: "n2", to: "n3" },
      { from: "n3", to: "n4" },
      { from: "n4", to: "n5" },
    ];
    const traces: BackwardTrace[] = [
      makeTrace(a, [...sharedEdges, { from: "n5", to: "n6" }]),
      makeTrace(b, [...sharedEdges]),
    ];
    const result = analyzeLogCoOccurrence(index, emptyCallGraph(), traces);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.relationship).toBe("trace-overlap");
    expect(result.groups[0]!.score).toBe(0.7);
  });

  it("clusters transitive pairs into a single group", () => {
    // A–B same-function, B–C same-file → A, B, C all in one group
    const a = tmpl("t1", "query failed", [loc("src/db.ts", 10)]);
    const b = tmpl("t2", "query timeout", [loc("src/db.ts", 15)]);
    const c = tmpl("t3", "connection reset", [loc("src/db.ts", 80)]);
    const index = makeLogIndex([a, b, c]);
    const result = analyzeLogCoOccurrence(index, emptyCallGraph(), []);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.templates).toHaveLength(3);
    // Best relationship within the group should be same-function (score 0.9)
    expect(result.groups[0]!.relationship).toBe("same-function");
    expect(result.groups[0]!.score).toBe(0.9);
  });

  it("infers sharedContext when templates share keywords", () => {
    const a = tmpl("t1", "database query failed", [loc("src/db.ts", 10)]);
    const b = tmpl("t2", "database connection lost", [loc("src/db.ts", 50)]);
    const index = makeLogIndex([a, b]);
    const result = analyzeLogCoOccurrence(index, emptyCallGraph(), []);

    expect(result.groups[0]!.sharedContext).toBe("database");
  });

  it("returns empty groups for single template", () => {
    const a = tmpl("t1", "oops", [loc("src/x.ts", 1)]);
    const result = analyzeLogCoOccurrence(makeLogIndex([a]), emptyCallGraph(), []);
    expect(result.groups).toHaveLength(0);
  });

  it("does not infer sharedContext from repeated keywords in a single template only", () => {
    // "database query sql failed" has 3 database keywords but only 1 template matches
    const a = tmpl("t1", "database query sql failed", [loc("src/db.ts", 10)]);
    const b = tmpl("t2", "unexpected panic", [loc("src/db.ts", 50)]);
    const c = tmpl("t3", "unknown error", [loc("src/db.ts", 90)]);
    const result = analyzeLogCoOccurrence(makeLogIndex([a, b, c]), emptyCallGraph(), []);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.sharedContext).toBeUndefined();
  });

  it("uses nearest lines across multiple locations for same-function classification", () => {
    // Template a has locations at line 10 and 200 in the same file
    // Template b is at line 25 — within 20 of line 10 but not line 200
    const a = tmpl("t1", "db timeout", [
      loc("src/db.ts", 10),
      loc("src/db.ts", 200),
    ]);
    const b = tmpl("t2", "db failed", [loc("src/db.ts", 25)]);
    const result = analyzeLogCoOccurrence(makeLogIndex([a, b]), emptyCallGraph(), []);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.relationship).toBe("same-function");
    expect(result.groups[0]!.score).toBe(0.9);
  });
});
