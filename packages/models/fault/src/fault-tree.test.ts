import { describe, it, expect } from "vitest";
import type { ControlFlowGraph, LogicalLocation } from "@mma/core";
import {
  buildFaultTree,
  analyzeGaps,
  analyzeCascadingRisk,
  analyzeTimeoutMissing,
  analyzeRetryWithoutBackoff,
  analyzeUncheckedNullReturn,
} from "./fault-tree.js";
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
      tracedEdges: [],
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
      tracedEdges: [],
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
      tracedEdges: [],
    };

    const tree = buildFaultTree(trace, "test-repo");
    expect(tree.topEvent.children).toHaveLength(0);
  });

  it("creates AND gate when conditions are on the same path", () => {
    const trace: BackwardTrace = {
      root: makeRoot(),
      steps: [
        step("n1", "condition", "if (x > 0)"),
        step("n2", "condition", "if (y < 10)"),
        step("n3", "entry", "function handleRequest"),
      ],
      crossServiceCalls: [],
      tracedEdges: [
        { from: "n1", to: "n2" },  // n1 reaches n2 → same path
        { from: "n3", to: "n1" },
      ],
    };

    const tree = buildFaultTree(trace, "test-repo");
    expect(tree.topEvent.children).toHaveLength(2); // AND gate + entry
    expect(tree.topEvent.children[0]!.kind).toBe("and-gate");
    expect(tree.topEvent.children[0]!.children).toHaveLength(2);
    expect(tree.topEvent.children[1]!.kind).toBe("undeveloped");
  });

  it("creates nested AND-inside-OR for mixed paths", () => {
    const trace: BackwardTrace = {
      root: makeRoot(),
      steps: [
        step("n1", "condition", "if (a)"),
        step("n2", "condition", "if (b)"),
        step("n3", "condition", "if (c)"),
        step("n4", "entry", "function handle"),
      ],
      crossServiceCalls: [],
      tracedEdges: [
        { from: "n1", to: "n2" },  // n1 and n2 on same path
        // n3 is on a separate path (no edges connecting to n1 or n2)
        { from: "n4", to: "n1" },
        { from: "n4", to: "n3" },
      ],
    };

    const tree = buildFaultTree(trace, "test-repo");
    // OR gate wrapping AND(n1,n2) and n3, plus entry
    expect(tree.topEvent.children).toHaveLength(2); // OR gate + entry
    const orGate = tree.topEvent.children[0]!;
    expect(orGate.kind).toBe("or-gate");
    expect(orGate.children).toHaveLength(2);
    // One child should be AND gate (n1,n2), other should be basic event (n3)
    const andChild = orGate.children.find(c => c.kind === "and-gate");
    const basicChild = orGate.children.find(c => c.kind === "basic-event");
    expect(andChild).toBeDefined();
    expect(andChild!.children).toHaveLength(2);
    expect(basicChild).toBeDefined();
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

  it("does not flag catch block with console.error logging", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "console.error(e)", location: loc },
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

  it("does not treat new Error() construction as logging", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "const err = new Error(\"wrapped\")", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(1); // no real logging — should still flag
    expect(results[0]!.ruleId).toBe("fault/unhandled-error-path");
  });

  it("does not match 'catalog' or 'dialog' as logging", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "updateCatalog()", location: loc },
        { id: "n3", kind: "statement", label: "showDialog()", location: loc },
        { id: "n4", kind: "statement", label: "catalog.error('item not found')", location: loc },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n1", to: "n3" },
        { from: "n1", to: "n4" },
      ],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(1); // no real logging present — catalog.error is not a logger
  });

  it("does not flag catch block with .catch() error forwarding", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "return promise.catch(handleErr)", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag catch block with reject() error forwarding", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "reject(err)", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag catch block with next(err) error forwarding", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "next(err)", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag catch block with prefixed logger (e.g. integratorLogger.error)", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "integratorLogger.error('failed', e)", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag catch block with contextLogger.warn", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "contextLogger.warn('retry failed', err)", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag catch block with this.log.error", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "this.log.error('operation failed', e)", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag catch block with callback(err) forwarding", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "callback(err)", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag catch block with custom error factory", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "appError.ServerError(err, callback)", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag catch block with handleError call", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "handleError(error, 'GET')", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag catch block with sentinel return value", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "return false", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag catch block returning an error object", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "return { error: e, success: false }", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("flags catch block with only assignment and no return, log, or rethrow", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        { id: "n2", kind: "statement", label: "errorCount++", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("fault/unhandled-error-path");
  });

  it("detects empty catch block as silent failure", () => {
    const cfg: ControlFlowGraph = {
      functionId: "test#fn",
      nodes: [
        { id: "n1", kind: "catch", label: "catch", location: loc },
        // No successor nodes at all — empty catch block
      ],
      edges: [],
    };

    const results = analyzeGaps(new Map([["test#fn", cfg]]), "test-repo");
    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("fault/silent-failure");
  });
});

describe("analyzeCascadingRisk", () => {
  it("flags cross-service call without circuit breaker", () => {
    const traces: BackwardTrace[] = [{
      root: makeRoot(),
      steps: [],
      crossServiceCalls: [{
        callerService: "src/api.ts",
        calleeService: "src/handler.ts",
        callSite: loc,
        targetMethod: "src/handler.ts#handleRequest",
      }],
      tracedEdges: [],
    }];

    const results = analyzeCascadingRisk(traces, "test-repo");
    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("fault/cascading-failure-risk");
  });

  it("does not flag calls with circuit breaker keywords", () => {
    const traces: BackwardTrace[] = [{
      root: makeRoot(),
      steps: [],
      crossServiceCalls: [{
        callerService: "src/api.ts",
        calleeService: "src/handler.ts",
        callSite: loc,
        targetMethod: "src/handler.ts#retryWithCircuitBreaker",
      }],
      tracedEdges: [],
    }];

    const results = analyzeCascadingRisk(traces, "test-repo");
    expect(results).toHaveLength(0);
  });

  it("deduplicates by caller-callee pair", () => {
    const call = {
      callerService: "src/api.ts",
      calleeService: "src/handler.ts",
      callSite: loc,
      targetMethod: "src/handler.ts#handle",
    };
    const traces: BackwardTrace[] = [
      { root: makeRoot(), steps: [], crossServiceCalls: [call], tracedEdges: [] },
      { root: makeRoot(), steps: [], crossServiceCalls: [call], tracedEdges: [] },
    ];

    const results = analyzeCascadingRisk(traces, "test-repo");
    expect(results).toHaveLength(1);
  });
});

describe("analyzeTimeoutMissing", () => {
  it("flags axios call with no timeout", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/client.ts#fetchData",
      nodes: [
        { id: "n1", kind: "statement", label: "const res = await axios.get(url)", location: loc },
        { id: "n2", kind: "statement", label: "return res.data", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeTimeoutMissing(new Map([["src/client.ts#fetchData", cfg]]), "test-repo");
    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("fault/timeout-missing");
  });

  it("does not flag axios call when timeout is configured", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/client.ts#fetchData",
      nodes: [
        { id: "n1", kind: "statement", label: "const res = await axios.get(url, { timeout: 5000 })", location: loc },
        { id: "n2", kind: "statement", label: "return res.data", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeTimeoutMissing(new Map([["src/client.ts#fetchData", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("flags fetch() call with no timeout", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/client.ts#loadResource",
      nodes: [
        { id: "n1", kind: "statement", label: "const res = await fetch(endpoint)", location: loc },
      ],
      edges: [],
    };

    const results = analyzeTimeoutMissing(new Map([["src/client.ts#loadResource", cfg]]), "test-repo");
    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("fault/timeout-missing");
  });

  it("does not flag functions without any HTTP call", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/utils.ts#formatDate",
      nodes: [
        { id: "n1", kind: "statement", label: "return new Date(ts).toISOString()", location: loc },
      ],
      edges: [],
    };

    const results = analyzeTimeoutMissing(new Map([["src/utils.ts#formatDate", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag files in test/ paths", () => {
    const cfg: ControlFlowGraph = {
      functionId: "tests/client.test.ts#fetchData",
      nodes: [
        { id: "n1", kind: "statement", label: "const res = await axios.get(url)", location: loc },
      ],
      edges: [],
    };

    const results = analyzeTimeoutMissing(new Map([["tests/client.test.ts#fetchData", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });
});

describe("analyzeRetryWithoutBackoff", () => {
  it("flags retry branch with fixed setTimeout and no backoff", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/retry.ts#retryOperation",
      nodes: [
        { id: "n1", kind: "branch", label: "if (attempt < maxAttempts)", location: loc },
        { id: "n2", kind: "statement", label: "await setTimeout(1000)", location: loc },
        { id: "n3", kind: "statement", label: "attempt++", location: loc },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
      ],
    };

    const results = analyzeRetryWithoutBackoff(new Map([["src/retry.ts#retryOperation", cfg]]), "test-repo");
    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("fault/retry-without-backoff");
  });

  it("does not flag retry loop with exponential backoff", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/retry.ts#retryOperation",
      nodes: [
        { id: "n1", kind: "branch", label: "if (retries < maxRetry)", location: loc },
        { id: "n2", kind: "statement", label: "const delay = baseDelay * Math.pow(2, retries)", location: loc },
        { id: "n3", kind: "statement", label: "await setTimeout(delay)", location: loc },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
      ],
    };

    const results = analyzeRetryWithoutBackoff(new Map([["src/retry.ts#retryOperation", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag retry loop with backoff multiplier pattern", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/retry.ts#withRetry",
      nodes: [
        { id: "n1", kind: "branch", label: "if (attempt < maxAttempts)", location: loc },
        { id: "n2", kind: "statement", label: "const delay = baseDelay * 2", location: loc },
        { id: "n3", kind: "statement", label: "setTimeout(fn, delay)", location: loc },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
      ],
    };

    const results = analyzeRetryWithoutBackoff(new Map([["src/retry.ts#withRetry", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag functions with no retry branch", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/worker.ts#processJob",
      nodes: [
        { id: "n1", kind: "statement", label: "const result = await doWork()", location: loc },
        { id: "n2", kind: "statement", label: "setTimeout(cleanup, 1000)", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeRetryWithoutBackoff(new Map([["src/worker.ts#processJob", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag retry branch that has no setTimeout", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/retry.ts#syncRetry",
      nodes: [
        { id: "n1", kind: "branch", label: "if (retries < maxRetry)", location: loc },
        { id: "n2", kind: "statement", label: "retries++", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeRetryWithoutBackoff(new Map([["src/retry.ts#syncRetry", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });
});

describe("analyzeUncheckedNullReturn", () => {
  it("flags findOne() call with no null guard", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/users.ts#getUser",
      nodes: [
        { id: "n1", kind: "statement", label: "const user = await User.findOne({ email })", location: loc },
        { id: "n2", kind: "statement", label: "return user.profile", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeUncheckedNullReturn(new Map([["src/users.ts#getUser", cfg]]), "test-repo");
    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("fault/unchecked-null-return");
  });

  it("does not flag findOne() when null guard is present", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/users.ts#getUser",
      nodes: [
        { id: "n1", kind: "statement", label: "const user = await User.findOne({ email })", location: loc },
        { id: "n2", kind: "branch", label: "if (!user)", location: loc },
        { id: "n3", kind: "statement", label: "throw new Error('User not found')", location: loc },
        { id: "n4", kind: "statement", label: "return user.profile", location: loc },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
        { from: "n2", to: "n4" },
      ],
    };

    const results = analyzeUncheckedNullReturn(new Map([["src/users.ts#getUser", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag findOne() when optional chaining is used", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/users.ts#getUserName",
      nodes: [
        { id: "n1", kind: "statement", label: "const user = await User.findOne({ id })", location: loc },
        { id: "n2", kind: "statement", label: "return user?.name", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeUncheckedNullReturn(new Map([["src/users.ts#getUserName", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("flags findById() call with no null guard", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/orders.ts#getOrder",
      nodes: [
        { id: "n1", kind: "statement", label: "const order = await Order.findById(id)", location: loc },
        { id: "n2", kind: "statement", label: "processOrder(order)", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeUncheckedNullReturn(new Map([["src/orders.ts#getOrder", cfg]]), "test-repo");
    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("fault/unchecked-null-return");
  });

  it("does not flag functions that have no nullable query", () => {
    const cfg: ControlFlowGraph = {
      functionId: "src/orders.ts#listOrders",
      nodes: [
        { id: "n1", kind: "statement", label: "const orders = await Order.find({ status: 'active' })", location: loc },
        { id: "n2", kind: "statement", label: "return orders", location: loc },
      ],
      edges: [{ from: "n1", to: "n2" }],
    };

    const results = analyzeUncheckedNullReturn(new Map([["src/orders.ts#listOrders", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag files in scripts/ paths", () => {
    const cfg: ControlFlowGraph = {
      functionId: "scripts/migrate.ts#getRecord",
      nodes: [
        { id: "n1", kind: "statement", label: "const rec = await Model.findOne({ legacy: true })", location: loc },
      ],
      edges: [],
    };

    const results = analyzeUncheckedNullReturn(new Map([["scripts/migrate.ts#getRecord", cfg]]), "test-repo");
    expect(results).toHaveLength(0);
  });
});
