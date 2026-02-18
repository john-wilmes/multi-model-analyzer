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
  const conditions = steps.filter((s) => s.kind === "condition");
  const entries = steps.filter((s) => s.kind === "entry");

  if (conditions.length === 0 && entries.length === 0) {
    return [];
  }

  // If multiple conditions, they form an OR gate (any path can trigger the error)
  if (conditions.length > 1) {
    return [
      {
        id: `gate-or-${conditions[0]!.nodeId}`,
        label: "Any of these conditions",
        kind: "or-gate",
        children: conditions.map((c) => ({
          id: `basic-${c.nodeId}`,
          label: c.description,
          kind: "basic-event" as const,
          location: c.location,
          children: [],
        })),
      },
    ];
  }

  // Single condition path
  return [
    ...conditions.map((c) => ({
      id: `basic-${c.nodeId}`,
      label: c.description,
      kind: "basic-event" as const,
      location: c.location,
      children: [] as FaultTreeNode[],
    })),
    ...entries.map((e) => ({
      id: `entry-${e.nodeId}`,
      label: `Entry: ${e.description}`,
      kind: "undeveloped" as const,
      location: e.location,
      children: [] as FaultTreeNode[],
    })),
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
      const successors = cfg.edges
        .filter((e) => e.from === catchNode.id)
        .map((e) => cfg.nodes.find((n) => n.id === e.to));

      const hasLogging = successors.some(
        (n) =>
          n &&
          (n.label.includes("log") ||
            n.label.includes("error") ||
            n.label.includes("console")),
      );

      const hasRethrow = successors.some(
        (n) => n && n.kind === "throw",
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

      if (!hasLogging && !hasRethrow) {
        results.push(
          createSarifResult(
            "fault/silent-failure",
            "warning",
            `Error silently swallowed in ${functionId}`,
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
