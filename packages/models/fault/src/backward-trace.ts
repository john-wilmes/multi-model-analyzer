/**
 * Backward CFG tracing from log statements to root causes.
 *
 * Given a log.error() location, trace backward through the control flow graph
 * to find all code paths that can reach it. Each branching condition becomes
 * a gate in the fault tree.
 */

import type { CallGraph, ControlFlowGraph, CfgEdge, LogicalLocation } from "@mma/core";
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
  readonly tracedEdges: readonly CfgEdge[];
  readonly failReason?: "no-fqn" | "no-cfg-match" | "no-log-node";
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
  const tracedEdges: CfgEdge[] = [];

  // Find the CFG containing this log statement.
  // fullyQualifiedName is "filePath:lineNumber" -- extract the file path
  // and search for a CFG whose key starts with that path.
  const fqn = root.location.fullyQualifiedName;
  const colonIdx = fqn?.lastIndexOf(":");
  const filePath = colonIdx != null && colonIdx > 0 ? fqn!.slice(0, colonIdx) : undefined;
  if (!filePath) {
    return { root, steps: [], crossServiceCalls: [], tracedEdges: [], failReason: "no-fqn" };
  }

  // CFGs are keyed as "filePath#functionName" -- find by file prefix
  let cfg: ControlFlowGraph | undefined;
  let containingFunction = "";
  let logNode: string | null = null;
  let anyCfgMatchedFile = false;
  for (const [key, candidate] of cfgs) {
    if (key.startsWith(filePath + "#")) {
      anyCfgMatchedFile = true;
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
    const failReason = anyCfgMatchedFile ? "no-log-node" : "no-cfg-match";
    return { root, steps: [], crossServiceCalls: [], tracedEdges: [], failReason };
  }

  // Trace backward through CFG
  const visited = new Set<string>();
  traceBackwardDFS(logNode, cfg, visited, steps, tracedEdges);

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

  return { root, steps, crossServiceCalls, tracedEdges };
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
    // Fuzzy fallback: find closest node within ±2 lines (first node wins ties)
    let bestNode: (typeof cfg.nodes)[number] | undefined;
    let bestDist = Infinity;
    for (const node of cfg.nodes) {
      if (node.line != null) {
        const dist = Math.abs(node.line - lineNum);
        if (dist <= 2 && dist < bestDist) {
          bestDist = dist;
          bestNode = node;
        }
      }
    }
    if (bestNode) return bestNode.id;
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

  // Strategy 3: match by severity keyword constrained to the root's severity
  // level. Matching any log call risks binding to the wrong statement when a
  // function contains multiple logging calls at different severities.
  const severity = root.template.severity.toLowerCase();
  // Map common severity aliases to their log-call forms.
  const sevAliases: Record<string, string> = {
    warning: "warn",
    warn: "warn",
    error: "error",
    fatal: "(?:fatal|error)",
    info: "info",
    debug: "debug",
    log: "log",
  };
  const sevPattern = sevAliases[severity] ?? severity;
  const SEV_RE = new RegExp(`\\.${sevPattern}\\s*\\(`, "i");
  for (const node of cfg.nodes) {
    if (node.kind === "statement" && SEV_RE.test(node.label)) {
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
  tracedEdges: CfgEdge[],
): void {
  if (visited.has(nodeId)) return;
  visited.add(nodeId);

  const node = cfg.nodes.find((n) => n.id === nodeId);
  if (!node) return;

  const kind = node.kind === "branch" ? "condition" as const
    : node.kind === "entry" ? "entry" as const
    : "error-source" as const;

  // Use the CFG node's own location so each step points at its source
  // position, not the root log statement's location.
  steps.push({
    nodeId,
    kind,
    description: node.label,
    location: node.location,
  });

  // Find predecessors
  const incomingEdges = cfg.edges.filter((e) => e.to === nodeId);
  for (const edge of incomingEdges) {
    tracedEdges.push(edge);
    traceBackwardDFS(edge.from, cfg, visited, steps, tracedEdges);
  }
}
