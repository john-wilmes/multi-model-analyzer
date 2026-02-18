/**
 * Backward CFG tracing from log statements to root causes.
 *
 * Given a log.error() location, trace backward through the control flow graph
 * to find all code paths that can reach it. Each branching condition becomes
 * a gate in the fault tree.
 */

import type { CallGraph, ControlFlowGraph, LogicalLocation } from "@mma/core";
import type { LogRoot } from "./log-roots.js";

export interface TraceStep {
  readonly nodeId: string;
  readonly kind: "condition" | "call" | "entry" | "error-source";
  readonly description: string;
  readonly location: LogicalLocation;
}

export interface BackwardTrace {
  readonly root: LogRoot;
  readonly steps: readonly TraceStep[];
  readonly crossServiceCalls: readonly CrossServiceCall[];
}

export interface CrossServiceCall {
  readonly callerService: string;
  readonly calleeService: string;
  readonly callSite: LogicalLocation;
  readonly targetMethod: string;
}

export function traceBackwardFromLog(
  root: LogRoot,
  cfgs: ReadonlyMap<string, ControlFlowGraph>,
  callGraph: CallGraph,
): BackwardTrace {
  const steps: TraceStep[] = [];
  const crossServiceCalls: CrossServiceCall[] = [];

  // Find the CFG containing this log statement.
  // fullyQualifiedName is "filePath:lineNumber" -- extract the file path
  // and search for a CFG whose key starts with that path.
  const fqn = root.location.fullyQualifiedName;
  const filePath = fqn?.split(":")[0];
  if (!filePath) {
    return { root, steps: [], crossServiceCalls: [] };
  }

  // Try exact match first, then prefix match on file path
  let cfg = cfgs.get(filePath);
  let containingFunction = filePath;
  if (!cfg) {
    for (const [key, candidate] of cfgs) {
      if (key.startsWith(filePath + "#")) {
        // Pick the first function in this file that contains a log-like node
        const logNode = findLogNode(candidate, root);
        if (logNode) {
          cfg = candidate;
          containingFunction = key;
          break;
        }
      }
    }
  }
  if (!cfg) {
    return { root, steps: [], crossServiceCalls: [] };
  }

  // Find the CFG node corresponding to the log statement
  const logNode = findLogNode(cfg, root);
  if (!logNode) {
    return { root, steps: [], crossServiceCalls: [] };
  }

  // Trace backward through CFG
  const visited = new Set<string>();
  traceBackwardDFS(
    logNode,
    cfg,
    visited,
    steps,
    root.location,
  );

  // Find callers of this function for cross-service tracing
  const callers = callGraph.edges.filter(
    (e) => e.target === containingFunction,
  );
  for (const caller of callers) {
    const callerModule = caller.source.split("#")[0] ?? "";
    const calleeModule = containingFunction.split("#")[0] ?? "";

    if (callerModule !== calleeModule) {
      crossServiceCalls.push({
        callerService: callerModule,
        calleeService: calleeModule,
        callSite: { repo: root.location.repo, module: callerModule },
        targetMethod: containingFunction,
      });
    }
  }

  return { root, steps, crossServiceCalls };
}

function findLogNode(
  cfg: ControlFlowGraph,
  _root: LogRoot,
): string | null {
  // Match by label content (log statements contain severity keywords)
  for (const node of cfg.nodes) {
    if (
      node.kind === "statement" &&
      (node.label.includes("error") ||
        node.label.includes("warn") ||
        node.label.includes("log"))
    ) {
      return node.id;
    }
  }
  return null;
}

function traceBackwardDFS(
  nodeId: string,
  cfg: ControlFlowGraph,
  visited: Set<string>,
  steps: TraceStep[],
  location: LogicalLocation,
): void {
  if (visited.has(nodeId)) return;
  visited.add(nodeId);

  const node = cfg.nodes.find((n) => n.id === nodeId);
  if (!node) return;

  const kind = node.kind === "branch" ? "condition" as const
    : node.kind === "entry" ? "entry" as const
    : "error-source" as const;

  steps.push({
    nodeId,
    kind,
    description: node.label,
    location,
  });

  // Find predecessors
  const incomingEdges = cfg.edges.filter((e) => e.to === nodeId);
  for (const edge of incomingEdges) {
    traceBackwardDFS(edge.from, cfg, visited, steps, location);
  }
}
