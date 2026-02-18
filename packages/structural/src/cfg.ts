/**
 * Intra-procedural control flow graph construction from tree-sitter AST.
 *
 * Used for backward tracing in fault tree analysis:
 * given a log.error() call, trace backward through all code paths that reach it.
 */

import type { CfgEdge, CfgNodeKind, ControlFlowGraph, ControlFlowNode, LogicalLocation } from "@mma/core";
import type { TreeSitterNode } from "@mma/parsing";

let nextId = 0;

function newNodeId(): string {
  return `cfg_${nextId++}`;
}

export function resetNodeIdCounter(): void {
  nextId = 0;
}

export function buildControlFlowGraph(
  functionNode: TreeSitterNode,
  functionId: string,
  repo: string,
  module: string,
): ControlFlowGraph {
  const nodes: ControlFlowNode[] = [];
  const edges: CfgEdge[] = [];

  const entryId = newNodeId();
  const exitId = newNodeId();

  const location: LogicalLocation = { repo, module, fullyQualifiedName: functionId };

  nodes.push({ id: entryId, kind: "entry", label: "entry", location });
  nodes.push({ id: exitId, kind: "exit", label: "exit", location });

  const lastNodeIds = buildCfgFromBlock(
    functionNode,
    [entryId],
    exitId,
    nodes,
    edges,
    location,
  );

  for (const lastId of lastNodeIds) {
    if (lastId !== exitId) {
      edges.push({ from: lastId, to: exitId });
    }
  }

  return { functionId, nodes, edges };
}

function buildCfgFromBlock(
  blockNode: TreeSitterNode,
  predecessorIds: string[],
  exitId: string,
  nodes: ControlFlowNode[],
  edges: CfgEdge[],
  location: LogicalLocation,
): string[] {
  let currentPredecessors = predecessorIds;

  for (const child of blockNode.namedChildren) {
    const result = buildCfgFromStatement(
      child,
      currentPredecessors,
      exitId,
      nodes,
      edges,
      location,
    );
    currentPredecessors = result;
  }

  return currentPredecessors;
}

function buildCfgFromStatement(
  node: TreeSitterNode,
  predecessorIds: string[],
  exitId: string,
  nodes: ControlFlowNode[],
  edges: CfgEdge[],
  location: LogicalLocation,
): string[] {
  const kind = statementKind(node.type);
  const nodeId = newNodeId();

  nodes.push({
    id: nodeId,
    kind,
    label: summarizeNode(node),
    location,
  });

  for (const predId of predecessorIds) {
    edges.push({ from: predId, to: nodeId });
  }

  switch (node.type) {
    case "if_statement":
      return buildIfCfg(node, nodeId, exitId, nodes, edges, location);

    case "try_statement":
      return buildTryCfg(node, nodeId, exitId, nodes, edges, location);

    case "for_statement":
    case "for_in_statement":
    case "while_statement":
    case "do_statement":
      return buildLoopCfg(node, nodeId, exitId, nodes, edges, location);

    case "return_statement":
      edges.push({ from: nodeId, to: exitId });
      return [];

    case "throw_statement": {
      const throwNodeId = newNodeId();
      nodes.push({
        id: throwNodeId,
        kind: "throw",
        label: "throw",
        location,
      });
      edges.push({ from: nodeId, to: throwNodeId });
      return [];
    }

    default:
      return [nodeId];
  }
}

function buildIfCfg(
  node: TreeSitterNode,
  branchNodeId: string,
  exitId: string,
  nodes: ControlFlowNode[],
  edges: CfgEdge[],
  location: LogicalLocation,
): string[] {
  const result: string[] = [];
  const consequence = node.namedChildren.find(
    (c) => c.type === "statement_block",
  );
  const alternative = node.namedChildren.find(
    (c) => c.type === "else_clause",
  );

  if (consequence) {
    const thenExits = buildCfgFromBlock(
      consequence,
      [branchNodeId],
      exitId,
      nodes,
      edges,
      location,
    );
    result.push(...thenExits);
  }

  if (alternative) {
    const elseBlock = alternative.namedChildren.find(
      (c) => c.type === "statement_block",
    );
    if (elseBlock) {
      const elseExits = buildCfgFromBlock(
        elseBlock,
        [branchNodeId],
        exitId,
        nodes,
        edges,
        location,
      );
      result.push(...elseExits);
    }
  } else {
    result.push(branchNodeId);
  }

  return result;
}

function buildTryCfg(
  node: TreeSitterNode,
  tryNodeId: string,
  exitId: string,
  nodes: ControlFlowNode[],
  edges: CfgEdge[],
  location: LogicalLocation,
): string[] {
  const result: string[] = [];

  const tryBlock = node.namedChildren.find((c) => c.type === "statement_block");
  const catchClause = node.namedChildren.find((c) => c.type === "catch_clause");
  const finallyClause = node.namedChildren.find((c) => c.type === "finally_clause");

  if (tryBlock) {
    const tryExits = buildCfgFromBlock(
      tryBlock,
      [tryNodeId],
      exitId,
      nodes,
      edges,
      location,
    );
    result.push(...tryExits);
  }

  if (catchClause) {
    const catchId = newNodeId();
    nodes.push({ id: catchId, kind: "catch", label: "catch", location });
    edges.push({ from: tryNodeId, to: catchId, condition: "exception" });

    const catchBlock = catchClause.namedChildren.find(
      (c) => c.type === "statement_block",
    );
    if (catchBlock) {
      const catchExits = buildCfgFromBlock(
        catchBlock,
        [catchId],
        exitId,
        nodes,
        edges,
        location,
      );
      result.push(...catchExits);
    }
  }

  if (finallyClause) {
    const finallyBlock = finallyClause.namedChildren.find(
      (c) => c.type === "statement_block",
    );
    if (finallyBlock) {
      const finallyExits = buildCfgFromBlock(
        finallyBlock,
        result,
        exitId,
        nodes,
        edges,
        location,
      );
      return finallyExits;
    }
  }

  return result;
}

function buildLoopCfg(
  node: TreeSitterNode,
  loopNodeId: string,
  exitId: string,
  nodes: ControlFlowNode[],
  edges: CfgEdge[],
  location: LogicalLocation,
): string[] {
  const body = node.namedChildren.find((c) => c.type === "statement_block");
  if (body) {
    const bodyExits = buildCfgFromBlock(
      body,
      [loopNodeId],
      exitId,
      nodes,
      edges,
      location,
    );
    // Loop back edge
    for (const bodyExit of bodyExits) {
      edges.push({ from: bodyExit, to: loopNodeId });
    }
  }
  // Exit edge (loop condition false)
  return [loopNodeId];
}

function statementKind(nodeType: string): CfgNodeKind {
  switch (nodeType) {
    case "if_statement":
      return "branch";
    case "for_statement":
    case "for_in_statement":
    case "while_statement":
    case "do_statement":
      return "loop";
    case "try_statement":
      return "try";
    case "catch_clause":
      return "catch";
    case "throw_statement":
      return "throw";
    case "return_statement":
      return "return";
    default:
      return "statement";
  }
}

function summarizeNode(node: TreeSitterNode): string {
  const text = node.text;
  if (text.length <= 60) return text;
  return text.slice(0, 57) + "...";
}

export function traceBackward(
  cfg: ControlFlowGraph,
  targetNodeId: string,
): string[] {
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(nodeId: string): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    path.push(nodeId);

    for (const edge of cfg.edges) {
      if (edge.to === nodeId) {
        dfs(edge.from);
      }
    }
  }

  dfs(targetNodeId);
  return path;
}
