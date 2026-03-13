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

  // Find the function body. For function declarations/expressions/methods the
  // body is a statement_block; for arrow functions it may be a statement_block
  // OR a bare expression (expression body form: `() => expr`).  Using the
  // named field "body" picks up the correct child for all three forms in
  // tree-sitter-typescript.
  const body =
    functionNode.childForFieldName("body") ??
    functionNode.namedChildren.find((ch) => ch.type === "statement_block");

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

    case "throw_statement":
      // nodeId already has kind "throw" from statementKind(); no extra node needed
      return [];

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
  const consequence = node.childForFieldName("consequence");
  const alternative = node.namedChildren.find(
    (ch) => ch.type === "else_clause",
  );

  if (consequence) {
    if (consequence.type === "statement_block") {
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
    } else {
      // Single-statement body (no braces)
      const thenExits = buildCfgFromStatement(
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
  }

  if (alternative) {
    const elseBody =
      alternative.childForFieldName("body") ??
      alternative.namedChildren.find(
        (ch) => ch.type === "statement_block" || ch.type === "if_statement",
      );
    if (elseBody) {
      if (elseBody.type === "statement_block") {
        const elseExits = buildCfgFromBlock(
          elseBody,
          [branchNodeId],
          exitId,
          nodes,
          edges,
          location,
          counter,
        );
        result.push(...elseExits);
      } else {
        // Single statement or else-if chain
        const elseExits = buildCfgFromStatement(
          elseBody,
          [branchNodeId],
          exitId,
          nodes,
          edges,
          location,
          counter,
        );
        result.push(...elseExits);
      }
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
  const tryBlock = node.namedChildren.find((ch) => ch.type === "statement_block");
  const catchClause = node.namedChildren.find((ch) => ch.type === "catch_clause");
  const finallyClause = node.namedChildren.find((ch) => ch.type === "finally_clause");

  // When a finally clause is present, all exits from the try/catch scope —
  // including return and throw statements — must flow through finally before
  // reaching the real function exit.  Insert a synthetic "finally entry" node
  // and use it as the exitId surrogate for the try/catch sub-graphs so that
  // return/throw nodes inside try/catch wire here instead of directly to the
  // real exitId.
  let innerExitId = exitId;
  let finallyEntryId: string | undefined;

  if (finallyClause) {
    finallyEntryId = newNodeId(counter);
    nodes.push({
      id: finallyEntryId,
      kind: "statement",
      label: "finally",
      location,
      line: finallyClause.startPosition.row + 1,
    });
    innerExitId = finallyEntryId;
  }

  const result: string[] = [];

  if (tryBlock) {
    const tryExits = buildCfgFromBlock(
      tryBlock,
      [tryNodeId],
      innerExitId,
      nodes,
      edges,
      location,
      counter,
    );
    result.push(...tryExits);
  }

  if (catchClause) {
    const catchId = newNodeId(counter);
    nodes.push({
      id: catchId,
      kind: "catch",
      label: "catch",
      location,
      line: catchClause.startPosition.row + 1,
    });
    edges.push({ from: tryNodeId, to: catchId, condition: "exception" });

    const catchBlock = catchClause.namedChildren.find(
      (ch) => ch.type === "statement_block",
    );
    if (catchBlock) {
      const catchExits = buildCfgFromBlock(
        catchBlock,
        [catchId],
        innerExitId,
        nodes,
        edges,
        location,
        counter,
      );
      result.push(...catchExits);
    }
  }

  if (finallyClause && finallyEntryId !== undefined) {
    const finallyBlock = finallyClause.namedChildren.find(
      (ch) => ch.type === "statement_block",
    );
    if (finallyBlock) {
      // Wire fall-through predecessors (try/catch normal exits) to finally entry.
      // return/throw nodes inside try/catch are already wired to finallyEntryId
      // via innerExitId above.
      for (const predId of result) {
        edges.push({ from: predId, to: finallyEntryId });
      }
      const finallyExits = buildCfgFromBlock(
        finallyBlock,
        [finallyEntryId],
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
  const body =
    node.childForFieldName("body") ??
    node.namedChildren.find((ch) => ch.type === "statement_block");

  if (node.type === "do_statement") {
    // do-while: body executes unconditionally first, then the condition is
    // checked.  loopNodeId represents the condition node at the bottom of the
    // loop.  The body runs with loopNodeId as its entry predecessor; after the
    // body completes it loops back to loopNodeId (re-check condition).  The
    // exit edge (condition false) falls through from loopNodeId.
    if (body) {
      let bodyExits: string[];
      if (body.type === "statement_block") {
        bodyExits = buildCfgFromBlock(body, [loopNodeId], exitId, nodes, edges, location, counter);
      } else {
        bodyExits = buildCfgFromStatement(body, [loopNodeId], exitId, nodes, edges, location, counter);
      }
      for (const bodyExit of bodyExits) {
        edges.push({ from: bodyExit, to: loopNodeId });
      }
    }
    return [loopNodeId];
  }

  // while / for / for-in: condition checked first (loopNodeId), then body
  if (body) {
    let bodyExits: string[];
    if (body.type === "statement_block") {
      bodyExits = buildCfgFromBlock(
        body,
        [loopNodeId],
        exitId,
        nodes,
        edges,
        location,
        counter,
      );
    } else {
      // Single-statement loop body (no braces)
      bodyExits = buildCfgFromStatement(
        body,
        [loopNodeId],
        exitId,
        nodes,
        edges,
        location,
        counter,
      );
    }
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
