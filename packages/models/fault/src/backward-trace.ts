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
  const colonIdx = fqn?.lastIndexOf(":");
  const filePath = colonIdx != null && colonIdx > 0 ? fqn!.slice(0, colonIdx) : undefined;
  if (!filePath) {
    return { root, steps: [], crossServiceCalls: [] };
  }

  // CFGs are keyed as "filePath#functionName" -- find by file prefix
  let cfg: ControlFlowGraph | undefined;
  let containingFunction = "";
  let logNode: string | null = null;
  for (const [key, candidate] of cfgs) {
    if (key.startsWith(filePath + "#")) {
      const found = findLogNode(candidate, root);
      if (found) {
        cfg = candidate;
        containingFunction = key;
        logNode = found;
        break;
      }
    }
  }
  if (!cfg || !logNode) {
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
  root: LogRoot,
): string | null {
  // Strategy 1: match by line number (most precise)
  const fqn = root.location.fullyQualifiedName ?? "";
  const colonIdx = fqn.lastIndexOf(":");
  const lineNum = colonIdx >= 0 ? parseInt(fqn.slice(colonIdx + 1), 10) : NaN;
  if (!isNaN(lineNum)) {
    for (const node of cfg.nodes) {
      if (node.line === lineNum) {
        return node.id;
      }
    }
  }

  // Strategy 2: match by the root's template text
  const templateText = root.template.template.toLowerCase();
  if (templateText.length > 0) {
    for (const node of cfg.nodes) {
      if (node.kind === "statement" && node.label.toLowerCase().includes(templateText)) {
        return node.id;
      }
    }
  }

  // Strategy 3: match by severity keywords (least precise)
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
