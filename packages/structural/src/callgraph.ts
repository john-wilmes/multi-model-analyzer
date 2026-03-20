/**
 * Call graph extraction.
 *
 * Two strategies:
 * 1. extractCallGraph (ts-morph) -- stub, returns empty edges.
 * 2. extractCallEdgesFromTreeSitter -- lightweight AST walk over tree-sitter nodes.
 */

import { makeSymbolId } from "@mma/core";
import type { CallGraph, GraphEdge } from "@mma/core";
import type { TsMorphProject, TsMorphSourceFile } from "@mma/parsing";

/** Minimal tree-sitter node interface for call graph extraction. */
export interface TsNode {
  readonly type: string;
  readonly text: string;
  readonly namedChildren: readonly TsNode[];
  readonly parent: TsNode | null;
  readonly startPosition: { readonly row: number; readonly column: number };
  childForFieldName(name: string): TsNode | null;
}

export interface CallGraphOptions {
  readonly includeExternalCalls: boolean;
  readonly maxDepth: number;
}

const DEFAULT_OPTIONS: CallGraphOptions = {
  includeExternalCalls: false,
  maxDepth: 10,
};

/**
 * Extract call graph from ts-morph project.
 *
 * @deprecated This is a stub that returns empty results. Use
 * {@link extractCallEdgesFromTreeSitter} instead for working call graph extraction.
 */
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

/**
 * Extract call edges from a single source file.
 *
 * @stub Full implementation requires ts-morph as a runtime dependency.
 * Will use findReferences and getCallExpressions to resolve function
 * calls to their declarations.
 */
function extractCallEdgesFromFile(
  _sourceFile: TsMorphSourceFile,
  _options: CallGraphOptions,
): GraphEdge[] {
  return [];
}

// ---------------------------------------------------------------------------
// Tree-sitter based call graph extraction
// ---------------------------------------------------------------------------

interface FunctionInfo {
  readonly name: string;
  readonly node: TsNode;
  readonly className: string | undefined;
}

/**
 * Extract call edges from a tree-sitter AST root node.
 *
 * Walks the AST to find function/method declarations, then finds all
 * call_expression nodes inside each function body and emits "calls" edges.
 */
export function extractCallEdgesFromTreeSitter(
  rootNode: TsNode,
  filePath: string,
  repo: string,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const functions = findFunctions(rootNode);

  for (const fn of functions) {
    collectCallEdges(fn.node, fn.name, filePath, repo, fn.className, edges);
  }

  return edges;
}

function findFunctions(rootNode: TsNode): FunctionInfo[] {
  const results: FunctionInfo[] = [];

  function walk(node: TsNode, className: string | undefined): void {
    if (
      node.type === "function_declaration" ||
      node.type === "function_expression" ||
      node.type === "method_definition"
    ) {
      const nameNode = node.namedChildren.find(
        (c) => c.type === "identifier" || c.type === "property_identifier",
      );
      const name = nameNode?.text ?? `anon_${node.startPosition.row}`;

      // For method_definition inside a class, capture the class name
      let enclosingClass = className;
      if (node.type === "method_definition" && !enclosingClass) {
        enclosingClass = findEnclosingClassName(node);
      }

      results.push({ name, node, className: enclosingClass });
    } else if (node.type === "arrow_function") {
      let name = `anon_${node.startPosition.row}`;
      const parent = node.parent;
      if (parent?.type === "variable_declarator") {
        const varName = parent.childForFieldName("name");
        if (varName) name = varName.text;
      } else if (parent?.type === "pair") {
        const key = parent.namedChildren.find(
          (c) => c.type === "property_identifier" || c.type === "string",
        );
        if (key) name = key.text;
      }
      results.push({ name, node, className });
    }

    // When entering a class_declaration/class, propagate class name to children
    const nextClass =
      node.type === "class_declaration" || node.type === "abstract_class_declaration" || node.type === "class"
        ? (node.namedChildren.find((c) => c.type === "type_identifier" || c.type === "identifier")?.text ?? className)
        : className;

    for (const child of node.namedChildren) {
      walk(child, nextClass);
    }
  }

  walk(rootNode, undefined);
  return results;
}

function findEnclosingClassName(node: TsNode): string | undefined {
  let current = node.parent;
  while (current) {
    if (current.type === "class_declaration" || current.type === "abstract_class_declaration" || current.type === "class") {
      const nameNode = current.namedChildren.find(
        (c) => c.type === "type_identifier" || c.type === "identifier",
      );
      return nameNode?.text;
    }
    current = current.parent;
  }
  return undefined;
}

function collectCallEdges(
  functionNode: TsNode,
  callerName: string,
  filePath: string,
  repo: string,
  className: string | undefined,
  edges: GraphEdge[],
): void {
  const source = className
    ? makeSymbolId(repo, filePath, `${className}.${callerName}`)
    : makeSymbolId(repo, filePath, callerName);

  function walk(node: TsNode): void {
    if (node.type === "call_expression") {
      const target = resolveCallTarget(node, filePath, className, repo);
      if (target) {
        edges.push({
          source,
          target,
          kind: "calls",
          metadata: { repo },
        });
      }
    }

    // Skip nested function/class declarations to avoid attributing
    // their calls to the outer function
    if (
      node !== functionNode &&
      (node.type === "function_declaration" ||
        node.type === "function_expression" ||
        node.type === "arrow_function" ||
        node.type === "method_definition" ||
        node.type === "class_declaration" ||
        node.type === "abstract_class_declaration" ||
        node.type === "class")
    ) {
      return;
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(functionNode);
}

function resolveCallTarget(
  callNode: TsNode,
  filePath: string,
  enclosingClassName: string | undefined,
  repo: string,
): string | null {
  const fnChild = callNode.childForFieldName("function");
  if (!fnChild) return null;

  if (fnChild.type === "identifier") {
    return fnChild.text;
  }

  if (fnChild.type === "member_expression") {
    const object = fnChild.childForFieldName("object");
    const property = fnChild.childForFieldName("property");
    if (!object || !property) return null;

    // this.method() -> resolve to ClassName.method
    if (object.type === "this" && enclosingClassName) {
      return makeSymbolId(repo, filePath, `${enclosingClassName}.${property.text}`);
    }

    // obj.method() -> "obj.method" (only for simple identifiers)
    // Skip complex expressions (new_expression, call chains, etc.) to avoid
    // garbage targets like "new Foo().bar"
    if (object.type === "identifier") {
      return `${object.text}.${property.text}`;
    }
    return null;
  }

  // Skip other patterns (new_expression is not a call_expression,
  // computed properties, etc.)
  return null;
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
