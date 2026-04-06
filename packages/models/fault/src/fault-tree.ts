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
    defaultConfiguration: { level: "note", enabled: true },
  },
  {
    id: "fault/cascading-failure-risk",
    shortDescription: {
      text: "Cross-service call chain with no circuit breaker pattern",
    },
    defaultConfiguration: { level: "note", enabled: true },
  },
  {
    id: "fault/traced-error-path",
    shortDescription: {
      text: "Backward trace from log statement to root causes with execution flow",
    },
    defaultConfiguration: { level: "note", enabled: true },
  },
  {
    id: "fault/timeout-missing",
    shortDescription: {
      text: "Outbound HTTP call with no timeout configured",
    },
    defaultConfiguration: { level: "warning", enabled: true },
  },
  {
    id: "fault/retry-without-backoff",
    shortDescription: {
      text: "Retry loop with fixed delay (no exponential backoff)",
    },
    defaultConfiguration: { level: "note", enabled: true },
  },
  {
    id: "fault/unchecked-null-return",
    shortDescription: {
      text: "Database query result used without null/undefined guard",
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

      // Sentinel returns (return false, return { error }, return fallbackValue)
      // are a valid error-handling strategy — control flow exits the handler
      // with a meaningful value rather than propagating the exception.
      const hasReturnValue = reachable.some(
        (n) => /\breturn\b/.test(n.label),
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

      if (!hasLogging && !hasRethrow && !hasErrorForwarding && !hasReturnValue) {
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

// Non-production path pattern — same exclusion as detectMissingErrorBoundaries
const NON_PROD_PATH_RE = /^(scripts|test|tests|__tests__|spec|fixtures|tools|bin)\//;

/**
 * Detect outbound HTTP calls without a timeout setting.
 *
 * Heuristic: a function contains an HTTP call pattern (axios, fetch, node http/https)
 * but no statement in the function mentions "timeout".
 */
export function analyzeTimeoutMissing(
  cfgs: ReadonlyMap<string, ControlFlowGraph>,
  repo: string,
): SarifResult[] {
  const results: SarifResult[] = [];

  // Patterns that indicate an outbound HTTP call
  const httpCallPattern =
    /\b(axios\.(get|post|put|delete|patch|head|request)|fetch\s*\(|https?\.(get|post|request)\s*\(|superagent\.(get|post|put|delete|patch)|nodeFetch\s*\(|got\s*\(|needle\.(get|post|put|delete))\b/i;

  for (const [functionId, cfg] of cfgs) {
    const filePath = functionId.split("#")[0] ?? "";
    if (NON_PROD_PATH_RE.test(filePath)) continue;

    const hasHttpCall = cfg.nodes.some(
      (n) => n.kind === "statement" && httpCallPattern.test(n.label),
    );
    if (!hasHttpCall) continue;

    const hasTimeout = cfg.nodes.some(
      (n) => /\btimeout\b/i.test(n.label),
    );
    if (hasTimeout) continue;

    const httpNode = cfg.nodes.find(
      (n) => n.kind === "statement" && httpCallPattern.test(n.label),
    )!;

    results.push(
      createSarifResult(
        "fault/timeout-missing",
        "warning",
        `Outbound HTTP call in ${functionId} has no timeout configured`,
        {
          locations: [{
            logicalLocations: [
              createLogicalLocation(repo, filePath, functionId),
            ],
          }],
          properties: { line: httpNode.line },
        },
      ),
    );
  }

  return results;
}

/**
 * Detect retry loops that use fixed delays instead of exponential backoff.
 *
 * Heuristic: a function has a loop/branch referencing retry/attempt counts
 * and a setTimeout call, but no backoff-indicating pattern.
 */
export function analyzeRetryWithoutBackoff(
  cfgs: ReadonlyMap<string, ControlFlowGraph>,
  repo: string,
): SarifResult[] {
  const results: SarifResult[] = [];

  const retryBranchPattern = /\b(retry|retries|attempt[s]?|maxRetry|maxAttempt[s]?)\b/i;
  const setTimeoutPattern = /\bsetTimeout\s*\(/;
  const backoffPattern = /\b(backoff|exponential|jitter|Math\.pow)\b|\bdelay\s*\*|\*\s*2\b|\bdelay\s*<<|\bdelay\s*\*\s*\d/i;

  for (const [functionId, cfg] of cfgs) {
    const filePath = functionId.split("#")[0] ?? "";
    if (NON_PROD_PATH_RE.test(filePath)) continue;

    const hasRetryBranch = cfg.nodes.some(
      (n) => (n.kind === "branch" || n.kind === "statement") && retryBranchPattern.test(n.label),
    );
    if (!hasRetryBranch) continue;

    const hasSetTimeout = cfg.nodes.some(
      (n) => n.kind === "statement" && setTimeoutPattern.test(n.label),
    );
    if (!hasSetTimeout) continue;

    const hasBackoff = cfg.nodes.some(
      (n) => backoffPattern.test(n.label),
    );
    if (hasBackoff) continue;

    results.push(
      createSarifResult(
        "fault/retry-without-backoff",
        "note",
        `Retry loop in ${functionId} uses fixed delay — consider exponential backoff`,
        {
          locations: [{
            logicalLocations: [
              createLogicalLocation(repo, filePath, functionId),
            ],
          }],
        },
      ),
    );
  }

  return results;
}

/**
 * Detect database query results used without a null/undefined guard.
 *
 * Heuristic: a function calls a query method that may return null (findOne,
 * findById, etc.) but has no null-guard branch or optional-chaining anywhere
 * in the function body.
 */
export function analyzeUncheckedNullReturn(
  cfgs: ReadonlyMap<string, ControlFlowGraph>,
  repo: string,
): SarifResult[] {
  const results: SarifResult[] = [];

  const nullableQueryPattern =
    /\.(findOne|findById|findByIdAndUpdate|findOneAndUpdate|findOneAndDelete|findOneAndReplace|findByPk|findFirst)\s*\(/;
  const nullGuardPattern =
    /(\s*!|\s*===?\s*null|\s*!==?\s*null|\s*===?\s*undefined|\s*!==?\s*undefined|\?\.\w|\?\s*\[|\bnullish\b|\bnull\b\s*\?)/;

  for (const [functionId, cfg] of cfgs) {
    const filePath = functionId.split("#")[0] ?? "";
    if (NON_PROD_PATH_RE.test(filePath)) continue;

    const queryNode = cfg.nodes.find(
      (n) => n.kind === "statement" && nullableQueryPattern.test(n.label),
    );
    if (!queryNode) continue;

    // Check whether any node in the function has a null guard
    const hasNullGuard = cfg.nodes.some(
      (n) => nullGuardPattern.test(n.label),
    );
    if (hasNullGuard) continue;

    results.push(
      createSarifResult(
        "fault/unchecked-null-return",
        "note",
        `${functionId} queries a nullable record (${queryNode.label.match(nullableQueryPattern)?.[1] ?? "findOne"}) without a null guard`,
        {
          locations: [{
            logicalLocations: [
              createLogicalLocation(repo, filePath, functionId),
            ],
          }],
          properties: { line: queryNode.line },
        },
      ),
    );
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
