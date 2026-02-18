/**
 * Call graph extraction from ts-morph symbol resolution.
 *
 * Builds function-to-function call edges by resolving identifiers
 * in call expressions to their declarations.
 */

import type { CallGraph, GraphEdge } from "@mma/core";
import type { TsMorphProject, TsMorphSourceFile } from "@mma/parsing";

export interface CallGraphOptions {
  readonly includeExternalCalls: boolean;
  readonly maxDepth: number;
}

const DEFAULT_OPTIONS: CallGraphOptions = {
  includeExternalCalls: false,
  maxDepth: 10,
};

export function extractCallGraph(
  project: TsMorphProject,
  repo: string,
  options: Partial<CallGraphOptions> = {},
): CallGraph {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const edges: GraphEdge[] = [];
  const nodes = new Set<string>();

  for (const sourceFile of project.getSourceFiles()) {
    const fileEdges = extractCallEdgesFromFile(sourceFile, opts);
    for (const edge of fileEdges) {
      edges.push(edge);
      nodes.add(edge.source);
      nodes.add(edge.target);
    }
  }

  return {
    repo,
    edges,
    nodeCount: nodes.size,
  };
}

function extractCallEdgesFromFile(
  _sourceFile: TsMorphSourceFile,
  _options: CallGraphOptions,
): GraphEdge[] {
  // Implementation will use ts-morph's findReferences and getCallExpressions
  // to resolve function calls to their declarations.
  //
  // For each function in the file:
  //   1. Get all call expressions within the function body
  //   2. For each call expression, resolve the identifier to its declaration
  //   3. Create an edge from the containing function to the called function
  //
  // This is a stub -- full implementation requires ts-morph as a runtime dep.
  return [];
}

export function findCallers(
  callGraph: CallGraph,
  targetFunction: string,
): readonly GraphEdge[] {
  return callGraph.edges.filter((e) => e.target === targetFunction);
}

export function findCallees(
  callGraph: CallGraph,
  sourceFunction: string,
): readonly GraphEdge[] {
  return callGraph.edges.filter((e) => e.source === sourceFunction);
}

export function getTransitiveDependencies(
  callGraph: CallGraph,
  startFunction: string,
  maxDepth: number = 10,
): Set<string> {
  const visited = new Set<string>();
  const queue: Array<{ node: string; depth: number }> = [
    { node: startFunction, depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.node) || current.depth > maxDepth) continue;
    visited.add(current.node);

    for (const edge of callGraph.edges) {
      if (edge.source === current.node && !visited.has(edge.target)) {
        queue.push({ node: edge.target, depth: current.depth + 1 });
      }
    }
  }

  visited.delete(startFunction);
  return visited;
}
