/**
 * Fault tree construction and gap analysis.
 *
 * Builds fault trees from backward traces:
 * - Top event = log.error/log.warn statement
 * - Gates = branching conditions (AND/OR)
 * - Basic events = root causes (leaf conditions)
 *
 * Also performs gap analysis: identifies error handling paths with no logging.
 */

import type {
  FaultTree,
  FaultTreeNode,
  ControlFlowGraph,
  ControlFlowNode,
  CfgEdge,
  SarifResult,
  SarifReportingDescriptor,
  SarifCodeFlow,
  SarifThreadFlow,
} from "@mma/core";
import { createSarifResult, createLogicalLocation } from "@mma/core";
import type { BackwardTrace, TraceStep } from "./backward-trace.js";

export const FAULT_RULES: readonly SarifReportingDescriptor[] = [
  {
    id: "fault/unhandled-error-path",
    shortDescription: {
      text: "Catch block with no logging or re-throw",
    },
    defaultConfiguration: { level: "warning", enabled: true },
  },
  {
    id: "fault/silent-failure",
    shortDescription: {
      text: "Error condition detected but swallowed",
    },
    defaultConfiguration: { level: "warning", enabled: true },
  },
  {
    id: "fault/missing-error-boundary",
    shortDescription: {
      text: "Async operation with no error handler",
    },
    defaultConfiguration: { level: "warning", enabled: true },
  },
  {
    id: "fault/cascading-failure-risk",
    shortDescription: {
      text: "Cross-service call chain with no circuit breaker pattern",
    },
    defaultConfiguration: { level: "note", enabled: true },
  },
];

export function buildFaultTree(
  trace: BackwardTrace,
  repo: string,
): FaultTree {
  const topEvent: FaultTreeNode = {
    id: `ft-${trace.root.id}`,
    label: `${trace.root.template.severity.toUpperCase()}: ${trace.root.template.template}`,
    kind: "top-event",
    location: trace.root.location,
    children: buildChildNodes(trace.steps, trace.tracedEdges),
  };

  return { topEvent, repo };
}

/**
 * Classify condition nodes as AND (same path) or OR (parallel paths)
 * using forward reachability on the traced CFG edges.
 */
function classifyConditions(
  conditionNodeIds: readonly string[],
  tracedEdges: readonly CfgEdge[],
): string[][] {
  if (conditionNodeIds.length <= 1) {
    return conditionNodeIds.length === 1 ? [[conditionNodeIds[0]!]] : [];
  }

  // Build forward adjacency from traced edges
  const adj = new Map<string, Set<string>>();
  for (const edge of tracedEdges) {
    let s = adj.get(edge.from);
    if (!s) { s = new Set(); adj.set(edge.from, s); }
    s.add(edge.to);
  }

  // Check if `from` can reach `to` via traced edges
  function canReach(from: string, to: string): boolean {
    const visited = new Set<string>();
    const queue = [from];
    while (queue.length > 0) {
      const node = queue.pop()!;
      if (node === to) return true;
      if (visited.has(node)) continue;
      visited.add(node);
      const neighbors = adj.get(node);
      if (neighbors) {
        for (const n of neighbors) queue.push(n);
      }
    }
    return false;
  }

  // Union-Find: conditions reachable from each other are on the same path
  const parent = new Map<string, string>();
  for (const id of conditionNodeIds) parent.set(id, id);

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  }

  function union(a: string, b: string): void {
    parent.set(find(a), find(b));
  }

  const ids = [...conditionNodeIds];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (canReach(ids[i]!, ids[j]!) || canReach(ids[j]!, ids[i]!)) {
        union(ids[i]!, ids[j]!);
      }
    }
  }

  // Collect groups
  const groups = new Map<string, string[]>();
  for (const id of conditionNodeIds) {
    const root = find(id);
    let group = groups.get(root);
    if (!group) { group = []; groups.set(root, group); }
    group.push(id);
  }

  return [...groups.values()];
}

function buildChildNodes(steps: readonly TraceStep[], tracedEdges: readonly CfgEdge[]): FaultTreeNode[] {
  if (steps.length === 0) {
    return [];
  }

  // Materialize all step kinds into fault tree nodes (same switch as before, keep it identical)
  const allNodes: FaultTreeNode[] = steps.map((s) => {
    switch (s.kind) {
      case "condition":
        return {
          id: `basic-${s.nodeId}`,
          label: s.description,
          kind: "basic-event" as const,
          location: s.location,
          children: [] as FaultTreeNode[],
        };
      case "entry":
        return {
          id: `entry-${s.nodeId}`,
          label: `Entry: ${s.description}`,
          kind: "undeveloped" as const,
          location: s.location,
          children: [] as FaultTreeNode[],
        };
      case "error-source":
        return {
          id: `source-${s.nodeId}`,
          label: `Error source: ${s.description}`,
          kind: "basic-event" as const,
          location: s.location,
          children: [] as FaultTreeNode[],
        };
      case "call":
        return {
          id: `call-${s.nodeId}`,
          label: `Call: ${s.description}`,
          kind: "undeveloped" as const,
          location: s.location,
          children: [] as FaultTreeNode[],
        };
    }
  });

  const conditionNodes = allNodes.filter((n) => n.id.startsWith("basic-"));
  const nonConditions = allNodes.filter((n) => !n.id.startsWith("basic-"));

  if (conditionNodes.length <= 1) {
    return allNodes;
  }

  // Classify conditions using traced edge topology
  const conditionSteps = steps.filter(s => s.kind === "condition");
  const conditionNodeIds = conditionSteps.map(s => s.nodeId);
  const groups = classifyConditions(conditionNodeIds, tracedEdges);

  // Map nodeId to FaultTreeNode
  const nodeById = new Map<string, FaultTreeNode>();
  for (const node of conditionNodes) {
    nodeById.set(node.id.replace("basic-", ""), node);
  }

  if (groups.length === 1) {
    // All conditions on same path → AND gate
    return [
      {
        id: `gate-and-${steps[0]!.nodeId}`,
        label: "All of these conditions",
        kind: "and-gate" as const,
        children: conditionNodes,
      },
      ...nonConditions,
    ];
  }

  // Multiple groups → OR gate, with AND gates for groups of size > 1
  const gateChildren: FaultTreeNode[] = groups.map((group) => {
    const nodes = group.map(id => nodeById.get(id)).filter((n): n is FaultTreeNode => n != null);
    if (nodes.length === 1) return nodes[0]!;
    return {
      id: `gate-and-${group[0]}`,
      label: "All of these conditions",
      kind: "and-gate" as const,
      children: nodes,
    };
  });

  return [
    {
      id: `gate-or-${steps[0]!.nodeId}`,
      label: "Any of these conditions",
      kind: "or-gate" as const,
      children: gateChildren,
    },
    ...nonConditions,
  ];
}

export function analyzeGaps(
  cfgs: ReadonlyMap<string, ControlFlowGraph>,
  repo: string,
): SarifResult[] {
  const results: SarifResult[] = [];

  for (const [functionId, cfg] of cfgs) {
    // Check for catch blocks with no logging
    const catchNodes = cfg.nodes.filter((n) => n.kind === "catch");
    for (const catchNode of catchNodes) {
      // Traverse all reachable nodes within the catch handler (not just direct
      // successors) so that handlers that perform cleanup before logging are
      // not falsely flagged.
      const reachable = reachableNodes(catchNode.id, cfg);

      // Match object.method call forms (console.error, logger.warn, integratorLogger.error, etc.)
      // and standalone logging calls (log(), warn(), error()). Case-sensitive to
      // avoid false-positives from `new Error(` or `new TypeError(`.
      const loggingPattern =
        /\b(console|[a-zA-Z]*Log(ger)?|log(ger)?|this\.log(ger)?)\s*\.\s*(log|error|warn|info|debug|trace|fatal)\s*\(|(?<!\.\s*)\b(log|warn|error)\s*\(/;
      const hasLogging = reachable.some(
        (n) => loggingPattern.test(n.label),
      );

      const hasRethrow = reachable.some(
        (n) => n.kind === "throw",
      );

      // Recognize Promise .catch() handlers, error-forwarding patterns
      // (reject, next, callback with error arg), and domain-specific error
      // response helpers (e.g., custom error factories, handleError).
      const errorForwardPattern =
        /\.catch\s*\(|\breject\s*\(|\bnext\s*\(\s*[^)\s][^)]*\)|\bcallback\s*\(\s*(err|error|e)\b|\b\w+Error\.\w+\s*\(|\bhandleError\s*\(/;
      const hasErrorForwarding = reachable.some(
        (n) => errorForwardPattern.test(n.label),
      );

      // Empty catch block = silent failure (swallowed error)
      if (reachable.length === 0) {
        results.push(
          createSarifResult(
            "fault/silent-failure",
            "warning",
            `Empty catch block in ${functionId} silently swallows errors`,
            {
              locations: [{
                logicalLocations: [
                  createLogicalLocation(repo, functionId, `${functionId}#catch`),
                ],
              }],
            },
          ),
        );
        continue;
      }

      if (!hasLogging && !hasRethrow && !hasErrorForwarding) {
        results.push(
          createSarifResult(
            "fault/unhandled-error-path",
            "warning",
            `Catch block in ${functionId} has no logging or re-throw`,
            {
              locations: [{
                logicalLocations: [
                  createLogicalLocation(repo, functionId, `${functionId}#catch`),
                ],
              }],
            },
          ),
        );
      }
    }
  }

  return results;
}

export function analyzeCascadingRisk(
  traces: readonly BackwardTrace[],
  repo: string,
): SarifResult[] {
  const seen = new Set<string>();
  const results: SarifResult[] = [];

  const circuitBreakerPattern = /circuit.?breaker|retry|fallback|timeout|bulkhead/i;

  for (const trace of traces) {
    for (const call of trace.crossServiceCalls) {
      const key = `${call.callerService}->${call.calleeService}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (!circuitBreakerPattern.test(call.targetMethod)) {
        results.push(
          createSarifResult(
            "fault/cascading-failure-risk",
            "note",
            `Cross-service call from ${call.callerService} to ${call.calleeService} (${call.targetMethod}) has no circuit breaker pattern`,
            {
              locations: [{
                logicalLocations: [
                  createLogicalLocation(repo, call.callerService, call.targetMethod),
                ],
              }],
            },
          ),
        );
      }
    }
  }

  return results;
}

/** @internal */
export function faultTreeToCodeFlow(
  tree: FaultTree,
): SarifCodeFlow {
  const locations = flattenTree(tree.topEvent);

  const threadFlow: SarifThreadFlow = {
    locations: locations.map((node, index) => ({
      location: {
        logicalLocations: node.location
          ? [
              createLogicalLocation(
                node.location.repo,
                node.location.module,
                node.location.fullyQualifiedName,
              ),
            ]
          : [],
      },
      nestingLevel: getDepth(tree.topEvent, node.id),
      executionOrder: index + 1,
      message: { text: node.label },
    })),
  };

  return {
    message: { text: tree.topEvent.label },
    threadFlows: [threadFlow],
  };
}

/**
 * Return all CFG nodes reachable from `startId` via forward edges,
 * excluding the start node itself.
 */
function reachableNodes(
  startId: string,
  cfg: ControlFlowGraph,
): ControlFlowNode[] {
  const visited = new Set<string>();
  const queue = [startId];
  const result: ControlFlowNode[] = [];

  while (queue.length > 0) {
    const id = queue.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);

    if (id !== startId) {
      const node = cfg.nodes.find((n) => n.id === id);
      if (node) result.push(node);
    }

    for (const edge of cfg.edges) {
      if (edge.from === id && !visited.has(edge.to)) {
        queue.push(edge.to);
      }
    }
  }

  return result;
}

function flattenTree(node: FaultTreeNode): FaultTreeNode[] {
  return [node, ...node.children.flatMap(flattenTree)];
}

function getDepth(root: FaultTreeNode, targetId: string, depth: number = 0): number {
  if (root.id === targetId) return depth;
  for (const child of root.children) {
    const found = getDepth(child, targetId, depth + 1);
    if (found >= 0) return found;
  }
  return -1;
}
