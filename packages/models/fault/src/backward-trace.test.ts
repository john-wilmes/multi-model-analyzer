/**
 * Tests for backward CFG tracing from log statements to root causes.
 */

import { describe, it, expect } from "vitest";
import type { ControlFlowGraph, CallGraph } from "@mma/core";
import type { LogRoot } from "./log-roots.js";
import { traceBackwardFromLog } from "./backward-trace.js";

function makeLogRoot(overrides: Partial<LogRoot> = {}): LogRoot {
  return {
    id: "root-1",
    template: {
      id: "t1",
      template: "error occurred",
      severity: "error",
      locations: [{ repo: "test-repo", module: "src/handler.ts" }],
      frequency: 1,
    },
    severity: "high",
    context: "error handler",
    location: {
      repo: "test-repo",
      module: "src/handler.ts",
      fullyQualifiedName: "src/handler.ts:10",
    },
    ...overrides,
  };
}

function makeCfg(functionId: string, overrides: Partial<ControlFlowGraph> = {}): ControlFlowGraph {
  return {
    functionId,
    nodes: [
      { id: "n1", kind: "entry", label: "function entry", location: { repo: "test-repo", module: "src/handler.ts" }, line: 1 },
      { id: "n2", kind: "branch", label: "if (condition)", location: { repo: "test-repo", module: "src/handler.ts" }, line: 5 },
      { id: "n3", kind: "statement", label: "log.error('error occurred')", location: { repo: "test-repo", module: "src/handler.ts" }, line: 10 },
    ],
    edges: [
      { from: "n1", to: "n2" },
      { from: "n2", to: "n3" },
    ],
    ...overrides,
  };
}

const emptyCallGraph: CallGraph = { repo: "test-repo", edges: [], nodeCount: 0 };

describe("traceBackwardFromLog", () => {
  it("traces backward through CFG to entry", () => {
    const root = makeLogRoot();
    const cfg = makeCfg("src/handler.ts#handleRequest");
    const cfgs = new Map([["src/handler.ts#handleRequest", cfg]]);

    const trace = traceBackwardFromLog(root, cfgs, emptyCallGraph);

    expect(trace.steps.length).toBeGreaterThan(0);
    // Should include the log node, the branch, and the entry
    expect(trace.steps.some((s) => s.kind === "error-source")).toBe(true);
    expect(trace.steps.some((s) => s.kind === "condition")).toBe(true);
    expect(trace.steps.some((s) => s.kind === "entry")).toBe(true);
  });

  it("returns empty steps when no CFG matches", () => {
    const root = makeLogRoot();
    const cfgs = new Map<string, ControlFlowGraph>();

    const trace = traceBackwardFromLog(root, cfgs, emptyCallGraph);

    expect(trace.steps).toHaveLength(0);
    expect(trace.crossServiceCalls).toHaveLength(0);
  });

  it("returns empty steps when location has no fullyQualifiedName", () => {
    const root = makeLogRoot({
      location: { repo: "test-repo", module: "src/handler.ts", fullyQualifiedName: undefined },
    });
    const cfgs = new Map([["src/handler.ts#fn", makeCfg("src/handler.ts#fn")]]);

    const trace = traceBackwardFromLog(root, cfgs, emptyCallGraph);

    expect(trace.steps).toHaveLength(0);
  });

  it("detects cross-service calls from call graph", () => {
    const root = makeLogRoot();
    const cfg = makeCfg("src/handler.ts#handleRequest");
    const cfgs = new Map([["src/handler.ts#handleRequest", cfg]]);

    const callGraph: CallGraph = {
      repo: "test-repo",
      edges: [
        { source: "src/api.ts#processRequest", target: "src/handler.ts#handleRequest", kind: "calls" },
      ],
      nodeCount: 2,
    };

    const trace = traceBackwardFromLog(root, cfgs, callGraph);

    expect(trace.crossServiceCalls).toHaveLength(1);
    expect(trace.crossServiceCalls[0]!.callerService).toBe("src/api.ts");
    expect(trace.crossServiceCalls[0]!.calleeService).toBe("src/handler.ts");
  });

  it("does not report same-module calls as cross-service", () => {
    const root = makeLogRoot();
    const cfg = makeCfg("src/handler.ts#handleRequest");
    const cfgs = new Map([["src/handler.ts#handleRequest", cfg]]);

    const callGraph: CallGraph = {
      repo: "test-repo",
      edges: [
        { source: "src/handler.ts#validate", target: "src/handler.ts#handleRequest", kind: "calls" },
      ],
      nodeCount: 2,
    };

    const trace = traceBackwardFromLog(root, cfgs, callGraph);

    expect(trace.crossServiceCalls).toHaveLength(0);
  });

  it("handles cycles in CFG without infinite loop", () => {
    const root = makeLogRoot();
    const cfg: ControlFlowGraph = {
      functionId: "src/handler.ts#loop",
      nodes: [
        { id: "n1", kind: "entry", label: "entry", location: { repo: "r", module: "m" }, line: 1 },
        { id: "n2", kind: "branch", label: "while(true)", location: { repo: "r", module: "m" }, line: 5 },
        { id: "n3", kind: "statement", label: "log.error('error occurred')", location: { repo: "r", module: "m" }, line: 10 },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
        { from: "n3", to: "n2" }, // cycle
      ],
    };
    const cfgs = new Map([["src/handler.ts#loop", cfg]]);

    const trace = traceBackwardFromLog(root, cfgs, emptyCallGraph);

    // Should complete without hanging; steps should be finite
    expect(trace.steps.length).toBeLessThanOrEqual(3);
  });

  it("matches log node by line number", () => {
    const root = makeLogRoot({
      location: { repo: "r", module: "src/handler.ts", fullyQualifiedName: "src/handler.ts:10" },
    });
    const cfg: ControlFlowGraph = {
      functionId: "src/handler.ts#fn",
      nodes: [
        { id: "e", kind: "entry", label: "entry", location: { repo: "r", module: "m" }, line: 1 },
        { id: "target", kind: "statement", label: "console.log('msg')", location: { repo: "r", module: "m" }, line: 10 },
      ],
      edges: [{ from: "e", to: "target" }],
    };
    const cfgs = new Map([["src/handler.ts#fn", cfg]]);

    const trace = traceBackwardFromLog(root, cfgs, emptyCallGraph);

    expect(trace.steps).toHaveLength(2); // target + entry
  });

  it("falls back to template text matching", () => {
    const root = makeLogRoot({
      location: { repo: "r", module: "src/handler.ts", fullyQualifiedName: "src/handler.ts:99" },
      template: {
        id: "t2",
        template: "connection failed",
        severity: "error",
        locations: [{ repo: "r", module: "src/handler.ts" }],
        frequency: 1,
      },
    });
    const cfg: ControlFlowGraph = {
      functionId: "src/handler.ts#fn",
      nodes: [
        { id: "e", kind: "entry", label: "entry", location: { repo: "r", module: "m" } },
        { id: "target", kind: "statement", label: "logger.error('Connection Failed')", location: { repo: "r", module: "m" } },
      ],
      edges: [{ from: "e", to: "target" }],
    };
    const cfgs = new Map([["src/handler.ts#fn", cfg]]);

    const trace = traceBackwardFromLog(root, cfgs, emptyCallGraph);

    expect(trace.steps.length).toBeGreaterThan(0);
  });
});
