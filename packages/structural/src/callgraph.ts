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
  readonly children: readonly TsNode[];
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
 * Binding metadata for an imported name.
 *
 * Stored in the import scope to allow call graph resolution to use the
 * original exported name (not the local alias) and to handle namespace
 * imports correctly.
 */
export interface ImportBinding {
  /** Resolved file path of the exporting module (no repo prefix). */
  readonly filePath: string;
  /**
   * Original export name in the exporting module.
   * - Named import `import { fetchData as load }` → `"fetchData"`
   * - Default import `import foo from './x'` → `"default"` (canonical)
   * - Namespace import `import * as ns from './x'` → equals the local name
   */
  readonly exportedName: string;
  /** True for `import * as ns` — method calls like `ns.method()` strip the namespace. */
  readonly isNamespace: boolean;
}

/**
 * Extract call edges from a tree-sitter AST root node.
 *
 * Walks the AST to find function/method declarations, then finds all
 * call_expression nodes inside each function body and emits "calls" edges.
 *
 * @param importScope - Optional map from local name to binding metadata for
 *   the module that exports it. When provided, bare identifier calls and
 *   receiver-qualified calls are resolved to the correct source file using
 *   the original exported name, not the local alias.
 */
export function extractCallEdgesFromTreeSitter(
  rootNode: TsNode,
  filePath: string,
  repo: string,
  importScope?: ReadonlyMap<string, ImportBinding>,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const functions = findFunctions(rootNode);

  for (const fn of functions) {
    collectCallEdges(fn.node, fn.name, filePath, repo, fn.className, edges, importScope);
  }

  // Deduplicate edges (same source->target pair)
  const seen = new Set<string>();
  return edges.filter(e => {
    const key = `${e.source}\0${e.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

/**
 * Collect all identifiers declared as parameters or local variables in a
 * function node (non-recursively — stops at nested function boundaries).
 *
 * Used to detect shadowed imports: if a function parameter or local const/let/var
 * has the same name as an imported binding, the local binding wins per JS
 * lexical scoping rules and the import scope should be ignored for that name.
 */
function collectLocalNames(fnNode: TsNode): Set<string> {
  const locals = new Set<string>();

  function addIdentifier(node: TsNode | null): void {
    if (!node) return;
    if (node.type === "identifier") { locals.add(node.text); return; }
    // Destructuring: `function f({ client })` or `const { client } = obj`
    if (node.type === "object_pattern" || node.type === "array_pattern") {
      for (const child of node.namedChildren) {
        if (child.type === "shorthand_property_identifier_pattern") {
          locals.add(child.text);
        } else if (child.type === "pair_pattern") {
          addIdentifier(child.childForFieldName("value"));
        } else {
          addIdentifier(child);
        }
      }
    }
  }

  function walk(node: TsNode, isRoot: boolean): void {
    // Stop at nested function boundaries (they have their own scope)
    if (!isRoot && (
      node.type === "function_declaration" ||
      node.type === "function_expression" ||
      node.type === "arrow_function" ||
      node.type === "method_definition"
    )) return;

    // Parameters from formal_parameters
    if (node.type === "formal_parameters") {
      for (const p of node.namedChildren) {
        // Simple param: `function f(a)`
        if (p.type === "identifier") { locals.add(p.text); continue; }
        // Typed/optional param: `function f(a: T)`, `function f(a?)`
        const pname = p.childForFieldName("pattern") ?? p.childForFieldName("name");
        addIdentifier(pname);
      }
    }

    // Local const/let/var declarations
    if (node.type === "variable_declarator") {
      addIdentifier(node.childForFieldName("name"));
    }

    for (const child of node.namedChildren) {
      walk(child, false);
    }
  }

  walk(fnNode, true);
  return locals;
}

function collectCallEdges(
  functionNode: TsNode,
  callerName: string,
  filePath: string,
  repo: string,
  className: string | undefined,
  edges: GraphEdge[],
  importScope?: ReadonlyMap<string, ImportBinding>,
): void {
  const source = className
    ? makeSymbolId(repo, filePath, `${className}.${callerName}`)
    : makeSymbolId(repo, filePath, callerName);

  // Build an effective scope that excludes names shadowed by local params/vars.
  // In JS, local bindings always win over module-level import bindings.
  let effectiveScope = importScope;
  if (importScope && importScope.size > 0) {
    const localNames = collectLocalNames(functionNode);
    if (localNames.size > 0) {
      const filtered = new Map(importScope);
      for (const name of localNames) filtered.delete(name);
      effectiveScope = filtered.size > 0 ? filtered : undefined;
    }
  }

  function walk(node: TsNode): void {
    if (node.type === "call_expression") {
      const target = resolveCallTarget(node, filePath, className, repo, effectiveScope);
      if (target) {
        edges.push({
          source,
          target,
          kind: "calls",
          repo,
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

/** Recursively resolve a member_expression chain to "a.b.c" form, up to maxDepth. */
function resolveMemberChain(node: TsNode, maxDepth: number): string | null {
  if (maxDepth <= 0) return null;
  const object = node.childForFieldName("object");
  const property = node.childForFieldName("property");
  if (!object || !property) return null;

  if (object.type === "identifier" || object.type === "this" || object.type === "super") {
    return `${object.text}.${property.text}`;
  }
  if (object.type === "member_expression") {
    const prefix = resolveMemberChain(object, maxDepth - 1);
    if (prefix) return `${prefix}.${property.text}`;
  }
  return null;
}

function resolveCallTarget(
  callNode: TsNode,
  filePath: string,
  enclosingClassName: string | undefined,
  repo: string,
  importScope?: ReadonlyMap<string, ImportBinding>,
): string | null {
  const fnChild = callNode.childForFieldName("function");
  if (!fnChild) return null;

  if (fnChild.type === "identifier") {
    // If the name is imported, resolve to the exporting file using the
    // original export name (not the local alias). E.g.
    // `import { fetchData as load }; load()` → repo:api.ts#fetchData
    const binding = importScope?.get(fnChild.text);
    if (binding) {
      // Namespace bindings (import * as ns / const ns = require()) are not
      // directly callable as functions — skip to avoid spurious edges.
      if (binding.isNamespace) return null;
      return makeSymbolId(repo, binding.filePath, binding.exportedName);
    }
    return makeSymbolId(repo, filePath, fnChild.text);
  }

  if (fnChild.type === "member_expression") {
    const property = fnChild.childForFieldName("property");
    if (!property) return null;

    const object = fnChild.childForFieldName("object");
    if (!object) return null;

    // this.method() -> resolve to ClassName.method (canonical ID, file known)
    if (object.type === "this" && enclosingClassName) {
      return makeSymbolId(repo, filePath, `${enclosingClassName}.${property.text}`);
    }

    if (object.type === "identifier") {
      const binding = importScope?.get(object.text);
      if (binding) {
        if (binding.isNamespace) {
          // import * as ns → ns.method() strips the namespace prefix so the
          // edge points to the actual exported symbol: repo:file.ts#method
          return makeSymbolId(repo, binding.filePath, property.text);
        }
        // Named/default import: use the exported name as the receiver so the
        // edge matches the declaration in the exporting file.
        // E.g. `import { httpClient as c }; c.get()` → repo:http.ts#httpClient.get
        return makeSymbolId(repo, binding.filePath, `${binding.exportedName}.${property.text}`);
      }
      // Unknown receiver — keep as a qualified name without a file segment so
      // the format is "repo:#obj.method" rather than a bare string.
      return makeSymbolId(repo, "", `${object.text}.${property.text}`);
    }

    // Chained: a.b.method() (resolve recursively, max 3 levels)
    if (object.type === "member_expression") {
      const prefix = resolveMemberChain(object, 3);
      if (prefix) return makeSymbolId(repo, "", `${prefix}.${property.text}`);
    }

    return null;
  }

  // Skip other patterns (new_expression is not a call_expression,
  // computed properties, etc.)
  return null;
}

/**
 * Build a local-name → ImportBinding scope from top-level import statements.
 *
 * Handles all import forms:
 * - `import { a, b as c } from './x'`  → `{ a: {x.ts, "a", false}, c: {x.ts, "b", false} }`
 * - `import def from './x'`             → `{ def: {x.ts, "default", false} }`
 * - `import * as ns from './x'`         → `{ ns: {x.ts, "ns", true} }`
 * - `const api = require('./x')`        → `{ api: {x.ts, "api", true} }` (namespace)
 * - `const { a } = require('./x')`      → `{ a: {x.ts, "a", false} }` (named)
 * - `const a = require('./x').a`        → `{ a: {x.ts, "a", false} }` (named member)
 *
 * The `exportedName` field preserves the original export name so aliased calls
 * like `import { fetchData as load }; load()` resolve to `file.ts#fetchData`.
 * The `isNamespace` flag causes `ns.method()` to resolve to `file.ts#method`.
 *
 * @param rootNode - Root node of the file's tree-sitter parse tree.
 * @param resolveSpecifier - Maps an import specifier to its resolved file path
 *   (bare path, no repo prefix). Return undefined for external/unresolvable
 *   specifiers so they are omitted from the scope.
 */
export function buildImportScopeFromAst(
  rootNode: TsNode,
  resolveSpecifier: (specifier: string) => string | undefined,
): Map<string, ImportBinding> {
  const scope = new Map<string, ImportBinding>();

  for (const child of rootNode.namedChildren) {
    if (child.type === "import_statement") {
      collectEsmImport(child, resolveSpecifier, scope);
    } else if (child.type === "lexical_declaration" && child.children[0]?.text === "const") {
      // Only immutable require() bindings are tracked; let/var may be reassigned
      collectCjsRequire(child, resolveSpecifier, scope);
    }
  }

  return scope;
}

/** Extract a specifier string from a `require('...')` call_expression node, or null. */
function extractRequireSpecifier(callNode: TsNode): string | null {
  const fn = callNode.childForFieldName("function");
  if (fn?.type !== "identifier" || fn.text !== "require") return null;
  const args = callNode.childForFieldName("arguments");
  if (!args) return null;
  const str = args.namedChildren.find((c) => c.type === "string");
  return str ? str.text.replace(/['"]/g, "") : null;
}

/** Handle ESM `import` statements. */
function collectEsmImport(
  child: TsNode,
  resolveSpecifier: (s: string) => string | undefined,
  scope: Map<string, ImportBinding>,
): void {
  let specifier: string | null = null;
  for (const c of child.namedChildren) {
    if (c.type === "string") { specifier = c.text.replace(/['"]/g, ""); break; }
  }
  if (!specifier) return;
  const resolved = resolveSpecifier(specifier);
  if (!resolved) return;

  for (const clauseChild of child.namedChildren) {
    if (clauseChild.type !== "import_clause") continue;
    for (const cc of clauseChild.namedChildren) {
      if (cc.type === "identifier") {
        // Default import: `import foo from '...'` → canonical exportedName "default"
        scope.set(cc.text, { filePath: resolved, exportedName: "default", isNamespace: false });
      } else if (cc.type === "namespace_import") {
        const id = cc.namedChildren.find((c) => c.type === "identifier");
        if (id) scope.set(id.text, { filePath: resolved, exportedName: id.text, isNamespace: true });
      } else if (cc.type === "named_imports") {
        for (const spec of cc.namedChildren) {
          if (spec.type !== "import_specifier") continue;
          const nameNode = spec.childForFieldName("name");
          const aliasNode = spec.childForFieldName("alias");
          const localNode = aliasNode ?? nameNode;
          if (localNode && nameNode) {
            scope.set(localNode.text, {
              filePath: resolved,
              exportedName: nameNode.text,
              isNamespace: false,
            });
          }
        }
      }
    }
  }
}

/**
 * Handle CJS `const x = require('...')` declarations.
 *
 * Three patterns:
 * - `const api = require('./x')`       → namespace binding (api.method → x#method)
 * - `const { a, b } = require('./x')`  → named bindings (a → x#a, b → x#b)
 * - `const a = require('./x').a`       → named member binding (a → x#a)
 */
function collectCjsRequire(
  declNode: TsNode,
  resolveSpecifier: (s: string) => string | undefined,
  scope: Map<string, ImportBinding>,
): void {
  for (const declarator of declNode.namedChildren) {
    if (declarator.type !== "variable_declarator") continue;

    const nameNode = declarator.childForFieldName("name");
    const valueNode = declarator.childForFieldName("value");
    if (!nameNode || !valueNode) continue;

    if (valueNode.type === "call_expression") {
      // `const api = require('./x')` or `const { a } = require('./x')`
      const specifier = extractRequireSpecifier(valueNode);
      if (!specifier) continue;
      const resolved = resolveSpecifier(specifier);
      if (!resolved) continue;

      if (nameNode.type === "identifier") {
        // Namespace: `const api = require('./x')` → api.method() → x#method
        scope.set(nameNode.text, { filePath: resolved, exportedName: nameNode.text, isNamespace: true });
      } else if (nameNode.type === "object_pattern") {
        // Destructure: `const { a, b } = require('./x')`
        for (const prop of nameNode.namedChildren) {
          if (prop.type === "shorthand_property_identifier_pattern") {
            scope.set(prop.text, { filePath: resolved, exportedName: prop.text, isNamespace: false });
          } else if (prop.type === "pair_pattern") {
            // `const { a: localA } = require('./x')`
            const key = prop.childForFieldName("key");
            const val = prop.childForFieldName("value");
            if (key && val && val.type === "identifier") {
              scope.set(val.text, { filePath: resolved, exportedName: key.text, isNamespace: false });
            }
          }
        }
      }
    } else if (valueNode.type === "member_expression") {
      // `const helper = require('./x').helper`
      const obj = valueNode.childForFieldName("object");
      const prop = valueNode.childForFieldName("property");
      if (!obj || !prop || obj.type !== "call_expression") continue;
      const specifier = extractRequireSpecifier(obj);
      if (!specifier) continue;
      const resolved = resolveSpecifier(specifier);
      if (!resolved) continue;
      if (nameNode.type === "identifier") {
        scope.set(nameNode.text, { filePath: resolved, exportedName: prop.text, isNamespace: false });
      }
    }
  }
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

/** Yield to the event loop to prevent blocking on large graph traversals. */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

export async function getTransitiveDependencies(
  callGraph: CallGraph,
  startFunction: string,
  maxDepth: number = 10,
): Promise<Set<string>> {
  const visited = new Set<string>();
  const queue: Array<{ node: string; depth: number }> = [
    { node: startFunction, depth: 0 },
  ];

  let iter = 0;
  while (queue.length > 0) {
    if (++iter % 1000 === 0) await yieldToEventLoop();
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
