import { describe, it, expect } from "vitest";
import type { ControlFlowGraph, LogicalLocation } from "@mma/core";
import { buildFaultTree, analyzeGaps } from "./fault-tree.js";
import type { BackwardTrace, TraceStep } from "./backward-trace.js";
import type { LogRoot } from "./log-roots.js";

const loc: LogicalLocation = { repo: "test-repo", module: "src/app.ts", fullyQualifiedName: "src/app.ts:10" };

function makeRoot(template: string = "request failed", severity: "error" | "warn" = "error"): LogRoot {
  return {
    id: "log-1",
    location: loc,
    template: { id: "tmpl-1", template, severity, locations: [loc], frequency: 1 },
    context: "general",
    severity: "high",
  };
}

function step(nodeId: string, kind: TraceStep["kind"], description: string): TraceStep {
  return { nodeId, kind, description, location: loc };
}

describe("buildFaultTree", () => {
  it("includes entry nodes alongside OR gate when multiple conditions exist", () => {
    const trace: BackwardTrace = {
      root: makeRoot(),
      steps: [
        step("n1", "condition", "if (x > 0)"),
        step("n2", "condition", "if (y < 10)"),
        step("n3", "entry", "function handleRequest"),
      ],
      crossServiceCalls: [],
    };

    const tree = buildFaultTree(trace, "test-repo");
    expect(tree.topEvent.children).toHaveLength(2); // OR gate + entry
    expect(tree.topEvent.children[0]!.kind).toBe("or-gate");
    expect(tree.topEvent.children[0]!.children).toHaveLength(2);
    expect(tree.topEvent.children[1]!.kind).toBe("undeveloped");
    expect(tree.topEvent.children[1]!.label).toContain("Entry:");
  });

  it("includes entries in single-condition path", () => {
    const trace: BackwardTrace = {
      root: makeRoot(),
      steps: [
        step("n1", "condition", "if (err)"),
        step("n2", "entry", "function process"),
      ],
      crossServiceCalls: [],
    };

    const tree = buildFaultTree(trace, "test-repo");
    expect(tree.topEvent.children).toHaveLength(2);
    expect(tree.topEvent.children[0]!.kind).toBe("basic-event");
    expect(tree.topEvent.children[1]!.kind).toBe("undeveloped");
  });

  it("returns empty children when no conditions or entries", () => {
    const trace: BackwardTrace = {
      root: makeRoot(),
      steps: [],
      crossServiceCalls: [],
    };

    const tree = buildFaultTree(trace, "test-repo");
    expect(tree.topEvent.children).toHaveLength(0);
  });
});

describe("analyzeGaps", () => {
  it("detects catch block with no logging or rethrow", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "cleanupResources()", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("fault/unhandled-error-path");
  });

  it("does not flag catch block with logging", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "logger.error(e)", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag catch block with rethrow", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "throw", label: "throw e", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not match 'catalog' or 'dialog' as logging", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "updateCatalog()", location: loc },
        { id: "n3", kind: "statement", label: "showDialog()", location: loc },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n1", to: "n3" },
      ],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(1); // no real logging present
  });
});
