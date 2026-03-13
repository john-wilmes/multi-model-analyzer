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
    children: buildChildNodes(trace.steps),
  };

  return { topEvent, repo };
}

function buildChildNodes(steps: readonly TraceStep[]): FaultTreeNode[] {
  if (steps.length === 0) {
    return [];
  }

  // Materialize all step kinds into fault tree nodes.
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

  // Multiple conditions on the backward trace represent alternative paths that
  // can each independently trigger the error — they form an OR gate.
  // Sequential conditions along a single path would require an AND gate, but
  // the backward DFS explores all predecessors so each condition node here
  // represents a distinct path to the error, making OR correct.
  if (conditionNodes.length > 1) {
    const nonConditions = allNodes.filter((n) => !n.id.startsWith("basic-"));
    return [
      {
        id: `gate-or-${steps[0]!.nodeId}`,
        label: "Any of these conditions",
        kind: "or-gate" as const,
        children: conditionNodes,
      },
      ...nonConditions,
    ];
  }

  return allNodes;
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

      const loggingPattern = /\b(log(ger)?|error|warn(ing)?|console)\s*[.(]/i;
      const hasLogging = reachable.some(
        (n) => loggingPattern.test(n.label),
      );

      const hasRethrow = reachable.some(
        (n) => n.kind === "throw",
      );

      if (!hasLogging && !hasRethrow) {
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
