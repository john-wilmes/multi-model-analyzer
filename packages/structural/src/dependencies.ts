/**
 * Dependency graph extraction via module-level import analysis.
 *
 * For POC: direct import/require parsing from AST.
 * For scale: dependency-cruiser integration for circular detection and rule violations.
 */

import type { DependencyGraph, GraphEdge } from "@mma/core";
import type { TreeSitterNode, TreeSitterTree } from "@mma/parsing";

export interface DependencyGraphOptions {
  readonly detectCircular: boolean;
  readonly ignorePatterns: readonly string[];
}

const DEFAULT_OPTIONS: DependencyGraphOptions = {
  detectCircular: true,
  ignorePatterns: ["node_modules"],
};

export function extractDependencyGraph(
  files: ReadonlyMap<string, TreeSitterTree>,
  repo: string,
  options: Partial<DependencyGraphOptions> = {},
): DependencyGraph {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const edges: GraphEdge[] = [];
  const knownPaths = new Set(files.keys());

  for (const [filePath, tree] of files) {
    const imports = extractImports(tree.rootNode);
    for (const imp of imports) {
      if (opts.ignorePatterns.some((p) => imp.includes(p))) continue;
      const resolved = resolveImportSpecifier(imp, filePath, knownPaths);
      edges.push({
        source: filePath,
        target: resolved,
        kind: "imports",
      });
    }
  }

  const circularDependencies = opts.detectCircular
    ? findCircularDependencies(edges)
    : [];

  return { repo, edges, circularDependencies };
}

function extractImports(rootNode: TreeSitterNode): string[] {
  const imports: string[] = [];

  for (const child of rootNode.namedChildren) {
    if (child.type === "import_statement") {
      const source = findStringLiteral(child);
      if (source) imports.push(source);
    } else if (child.type === "expression_statement") {
      // Handle require() calls
      const req = findRequireCall(child);
      if (req) imports.push(req);
    }
  }

  return imports;
}

function findStringLiteral(node: TreeSitterNode): string | null {
  for (const child of node.namedChildren) {
    if (child.type === "string" || child.type === "string_fragment") {
      return child.text.replace(/['"]/g, "");
    }
    const found = findStringLiteral(child);
    if (found) return found;
  }
  return null;
}

function findRequireCall(node: TreeSitterNode): string | null {
  for (const child of node.namedChildren) {
    if (child.type === "call_expression") {
      const callee = child.namedChildren.find((c) => c.type === "identifier");
      if (callee?.text === "require") {
        return findStringLiteral(child);
      }
    }
    const found = findRequireCall(child);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve a relative import specifier to a file path in the known file set.
 * Falls back to the raw specifier if no match is found (e.g. external packages).
 */
export function resolveImportSpecifier(
  specifier: string,
  importerPath: string,
  knownPaths: ReadonlySet<string>,
): string {
  // Non-relative imports (packages) -- return as-is
  if (!specifier.startsWith(".")) return specifier;

  const dir = importerPath.includes("/")
    ? importerPath.slice(0, importerPath.lastIndexOf("/"))
    : "";

  // Normalize: join dir + specifier, resolve . and ..
  const parts = (dir ? dir + "/" + specifier : specifier).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  const base = resolved.join("/");

  // Try extensions in order
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"];
  for (const ext of extensions) {
    const candidate = base + ext;
    if (knownPaths.has(candidate)) return candidate;
  }

  // No match found -- return raw specifier
  return specifier;
}

function findCircularDependencies(edges: readonly GraphEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);
    path.push(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      dfs(neighbor, [...path]);
    }

    stack.delete(node);
  }

  for (const node of adjacency.keys()) {
    dfs(node, []);
  }

  return cycles;
}

export function findDependentsOf(
  graph: DependencyGraph,
  module: string,
): readonly string[] {
  return graph.edges
    .filter((e) => e.target === module)
    .map((e) => e.source);
}

export function findDependenciesOf(
  graph: DependencyGraph,
  module: string,
): readonly string[] {
  return graph.edges
    .filter((e) => e.source === module)
    .map((e) => e.target);
}
