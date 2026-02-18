/**
 * Intra-procedural control flow graph construction from tree-sitter AST.
 *
 * Used for backward tracing in fault tree analysis:
 * given a log.error() call, trace backward through all code paths that reach it.
 */

import type { CfgEdge, CfgNodeKind, ControlFlowGraph, ControlFlowNode, LogicalLocation } from "@mma/core";
import type { TreeSitterNode } from "@mma/parsing";

export interface CfgIdCounter {
  value: number;
}

export function createCfgIdCounter(): CfgIdCounter {
  return { value: 0 };
}

/** @deprecated Use createCfgIdCounter() + pass counter to buildControlFlowGraph */
export function resetNodeIdCounter(): void {
  globalCounter.value = 0;
}

const globalCounter: CfgIdCounter = { value: 0 };

function newNodeId(counter: CfgIdCounter): string {
  return `cfg_${counter.value++}`;
}

export function buildControlFlowGraph(
  functionNode: TreeSitterNode,
  functionId: string,
  repo: string,
  module: string,
  counter?: CfgIdCounter,
): ControlFlowGraph {
  const c = counter ?? globalCounter;
  const nodes: ControlFlowNode[] = [];
  const edges: CfgEdge[] = [];

  const entryId = newNodeId(c);
  const exitId = newNodeId(c);

  const location: LogicalLocation = { repo, module, fullyQualifiedName: functionId };

  nodes.push({ id: entryId, kind: "entry", label: "entry", location });
  nodes.push({ id: exitId, kind: "exit", label: "exit", location });

  // Find the function body (statement_block) rather than iterating the
  // function node's top-level children (identifier, params, etc.)
  const body = functionNode.namedChildren.find(
    (ch) => ch.type === "statement_block",
  );

  const lastNodeIds = buildCfgFromBlock(
    body ?? functionNode,
    [entryId],
    exitId,
    nodes,
    edges,
    location,
    c,
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
  counter: CfgIdCounter,
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
      counter,
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
  counter: CfgIdCounter,
): string[] {
  const kind = statementKind(node.type);
  const nodeId = newNodeId(counter);

  nodes.push({
    id: nodeId,
    kind,
    label: summarizeNode(node),
    location,
    line: node.startPosition.row + 1,
  });

  for (const predId of predecessorIds) {
    edges.push({ from: predId, to: nodeId });
  }

  switch (node.type) {
    case "if_statement":
      return buildIfCfg(node, nodeId, exitId, nodes, edges, location, counter);

    case "try_statement":
      return buildTryCfg(node, nodeId, exitId, nodes, edges, location, counter);

    case "for_statement":
    case "for_in_statement":
    case "while_statement":
    case "do_statement":
      return buildLoopCfg(node, nodeId, exitId, nodes, edges, location, counter);

    case "return_statement":
      edges.push({ from: nodeId, to: exitId });
      return [];

    case "throw_statement": {
      const throwNodeId = newNodeId(counter);
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
  counter: CfgIdCounter,
): string[] {
  const result: string[] = [];
  const consequence = node.namedChildren.find(
    (ch) => ch.type === "statement_block",
  );
  const alternative = node.namedChildren.find(
    (ch) => ch.type === "else_clause",
  );

  if (consequence) {
    const thenExits = buildCfgFromBlock(
      consequence,
      [branchNodeId],
      exitId,
      nodes,
      edges,
      location,
      counter,
    );
    result.push(...thenExits);
  }

  if (alternative) {
    const elseBlock = alternative.namedChildren.find(
      (ch) => ch.type === "statement_block",
    );
    if (elseBlock) {
      const elseExits = buildCfgFromBlock(
        elseBlock,
        [branchNodeId],
        exitId,
        nodes,
        edges,
        location,
        counter,
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
  counter: CfgIdCounter,
): string[] {
  const result: string[] = [];

  const tryBlock = node.namedChildren.find((ch) => ch.type === "statement_block");
  const catchClause = node.namedChildren.find((ch) => ch.type === "catch_clause");
  const finallyClause = node.namedChildren.find((ch) => ch.type === "finally_clause");

  if (tryBlock) {
    const tryExits = buildCfgFromBlock(
      tryBlock,
      [tryNodeId],
      exitId,
      nodes,
      edges,
      location,
      counter,
    );
    result.push(...tryExits);
  }

  if (catchClause) {
    const catchId = newNodeId(counter);
    nodes.push({ id: catchId, kind: "catch", label: "catch", location });
    edges.push({ from: tryNodeId, to: catchId, condition: "exception" });

    const catchBlock = catchClause.namedChildren.find(
      (ch) => ch.type === "statement_block",
    );
    if (catchBlock) {
      const catchExits = buildCfgFromBlock(
        catchBlock,
        [catchId],
        exitId,
        nodes,
        edges,
        location,
        counter,
      );
      result.push(...catchExits);
    }
  }

  if (finallyClause) {
    const finallyBlock = finallyClause.namedChildren.find(
      (ch) => ch.type === "statement_block",
    );
    if (finallyBlock) {
      const finallyExits = buildCfgFromBlock(
        finallyBlock,
        result,
        exitId,
        nodes,
        edges,
        location,
        counter,
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
  counter: CfgIdCounter,
): string[] {
  const body = node.namedChildren.find((ch) => ch.type === "statement_block");
  if (body) {
    const bodyExits = buildCfgFromBlock(
      body,
      [loopNodeId],
      exitId,
      nodes,
      edges,
      location,
      counter,
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
