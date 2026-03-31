/**
 * Dependency graph extraction via module-level import analysis.
 *
 * For POC: direct import/require parsing from AST.
 * For scale: dependency-cruiser integration for circular detection and rule violations.
 */

import { relative } from "node:path";
import { makeFileId } from "@mma/core";
import type { DependencyGraph, GraphEdge } from "@mma/core";
import type { TreeSitterNode, TreeSitterTree } from "@mma/parsing";

export interface DependencyGraphOptions {
  readonly detectCircular: boolean;
  readonly ignorePatterns: readonly string[];
  /**
   * When true, barrel-mediated cycles are removed from `circularDependencies`
   * at detection time.  A cycle is barrel-mediated when at least one node in
   * the cycle is an `index.{ts,tsx,js,jsx}` file whose entire body consists of
   * re-export statements (see `isBarrelFile`).  Requires `detectCircular: true`
   * and the `files` argument to `extractDependencyGraph`.
   */
  readonly suppressBarrelCycles: boolean;
}

const DEFAULT_OPTIONS: DependencyGraphOptions = {
  detectCircular: true,
  ignorePatterns: ["node_modules"],
  suppressBarrelCycles: false,
};

export function extractDependencyGraph(
  files: ReadonlyMap<string, TreeSitterTree>,
  repo: string,
  options: Partial<DependencyGraphOptions> = {},
  packageRoots?: ReadonlyMap<string, string>,
  repoRoot?: string,
): DependencyGraph {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const edges: GraphEdge[] = [];
  const knownPaths = new Set(files.keys());

  // Relativize absolute packageRoots for probing against relative knownPaths.
  // Keep non-matching entries (packages outside this repo) in their original
  // absolute form so cross-repo resolution still works.
  let localRoots = packageRoots;
  if (packageRoots && repoRoot) {
    const merged = new Map<string, string>();
    for (const [name, dir] of packageRoots) {
      const rel = relative(repoRoot, dir).replace(/\\/g, "/");
      if (!rel.startsWith("..")) {
        merged.set(name, rel);
      } else {
        merged.set(name, dir);
      }
    }
    localRoots = merged;
  }

  const seenEdges = new Set<string>();
  for (const [filePath, tree] of files) {
    const imports = extractImports(tree.rootNode);
    // Hoist makeFileId out of the inner loop — computed once per file.
    const source = makeFileId(repo, filePath);
    for (const imp of imports) {
      if (opts.ignorePatterns.some((p) => imp.specifier.includes(p))) continue;
      const resolved = resolveImportSpecifier(imp.specifier, filePath, knownPaths, localRoots);
      // Use canonical ID for local files so source and target share the same
      // namespace (enabling cycle detection). External specifiers stay as-is.
      const target = knownPaths.has(resolved) ? makeFileId(repo, resolved) : resolved;
      const edgeKey = `${source}\0${target}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      const metadata: Record<string, unknown> = { repo };
      if (imp.importedNames.length > 0) {
        metadata.importedNames = imp.importedNames;
      }
      edges.push({
        source,
        target,
        kind: "imports",
        repo,
        metadata,
      });
    }
  }

  let circularDependencies = opts.detectCircular
    ? findCircularDependencies(edges)
    : [];

  if (opts.suppressBarrelCycles && circularDependencies.length > 0) {
    const annotated = tagBarrelMediatedCycles(circularDependencies, files, repo);
    circularDependencies = annotated
      .filter((a) => !a.barrelMediated)
      .map((a) => a.cycle);
  }

  return { repo, edges, circularDependencies };
}

/**
 * Bundler loader prefixes (Vite, webpack, etc.) that appear before the real
 * module specifier, e.g. `import 'directcss:./styles.css'`.  We strip these
 * so the underlying path resolves normally (or is dropped as an external).
 */
const LOADER_PREFIXES = [
  "directcss:",
  "raw:",
  "url:",
  "inline:",
  "asset:",
  "worker:",
  "sharedworker:",
  "raw-loader!",
  "url-loader!",
  "file-loader!",
];

/** Strip a bundler loader prefix from an import specifier, if present. */
function stripLoaderPrefix(specifier: string): string {
  for (const prefix of LOADER_PREFIXES) {
    if (specifier.startsWith(prefix)) {
      return specifier.slice(prefix.length);
    }
  }
  return specifier;
}

/** An import with its source specifier and the names it imports. */
export interface ImportInfo {
  readonly specifier: string;
  readonly importedNames: string[];
}

function extractImports(rootNode: TreeSitterNode): ImportInfo[] {
  const imports: ImportInfo[] = [];

  for (const child of rootNode.namedChildren) {
    if (child.type === "import_statement") {
      const source = findStringLiteral(child);
      if (source) {
        const names = extractImportedNames(child);
        imports.push({ specifier: stripLoaderPrefix(source), importedNames: names });
      }
    } else if (child.type === "expression_statement") {
      // Handle bare require() calls: require('./side-effect')
      const req = findRequireCall(child);
      if (req) imports.push({ specifier: stripLoaderPrefix(req), importedNames: [] });
    } else if (
      child.type === "lexical_declaration" ||
      child.type === "variable_declaration"
    ) {
      // Handle CJS: const x = require('...'), const { a, b } = require('...')
      for (const declarator of child.namedChildren) {
        if (declarator.type !== "variable_declarator") continue;
        const req = findRequireCall(declarator);
        if (req) {
          const names = extractRequireNames(declarator);
          imports.push({ specifier: stripLoaderPrefix(req), importedNames: names });
        }
      }
    } else if (child.type === "export_statement") {
      // Handle re-exports: export * from './x', export { X } from './x'
      // Use the "source" field to avoid matching strings inside exported class/function bodies
      const sourceNode = child.childForFieldName("source");
      if (sourceNode) {
        const source = findStringLiteral(sourceNode);
        if (source) {
          const names = extractReexportNames(child);
          imports.push({ specifier: stripLoaderPrefix(source), importedNames: names });
        }
      }
    }
  }

  return imports;
}

/**
 * Extract imported symbol names from an import_statement node.
 * - `import { a, b } from '…'` → `["a", "b"]`
 * - `import * as ns from '…'` → `["*"]`
 * - `import def from '…'` → `["default"]`
 * - `import def, { a } from '…'` → `["default", "a"]`
 * - `import '…'` (side-effect) → `[]`
 */
function extractImportedNames(importNode: TreeSitterNode): string[] {
  const names: string[] = [];

  for (const child of importNode.namedChildren) {
    if (child.type === "import_clause") {
      for (const clauseChild of child.namedChildren) {
        if (clauseChild.type === "identifier") {
          // Default import
          names.push("default");
        } else if (clauseChild.type === "namespace_import") {
          names.push("*");
        } else if (clauseChild.type === "named_imports") {
          for (const spec of clauseChild.namedChildren) {
            if (spec.type === "import_specifier") {
              // The "name" field is the imported name; "alias" is the local name
              const nameNode = spec.childForFieldName("name");
              if (nameNode) {
                names.push(nameNode.text);
              } else if (spec.namedChildren.length > 0) {
                names.push(spec.namedChildren[0]!.text);
              }
            }
          }
        }
      }
    }
  }

  return names;
}

/**
 * Extract re-exported names from an export_statement with a source.
 * - `export { a, b } from '…'` → `["a", "b"]`
 * - `export * from '…'` → `["*"]`
 * - `export * as ns from '…'` → `["*"]`
 */
function extractReexportNames(exportNode: TreeSitterNode): string[] {
  const names: string[] = [];
  let hasNamedExports = false;

  for (const child of exportNode.namedChildren) {
    if (child.type === "export_clause") {
      hasNamedExports = true;
      for (const spec of child.namedChildren) {
        if (spec.type === "export_specifier") {
          const nameNode = spec.childForFieldName("name");
          if (nameNode) {
            names.push(nameNode.text);
          } else if (spec.namedChildren.length > 0) {
            names.push(spec.namedChildren[0]!.text);
          }
        }
      }
    } else if (child.type === "namespace_export") {
      names.push("*");
      hasNamedExports = true;
    }
  }

  // `export * from '…'` has no export_clause or namespace_export child —
  // it's just the keywords "export", "*", "from", and the string.
  if (!hasNamedExports) {
    // Check for bare `*` token in non-named children
    for (let i = 0; i < exportNode.childCount; i++) {
      const child = exportNode.child(i);
      if (child && child.type === "*") {
        names.push("*");
        break;
      }
    }
  }

  return names;
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
 * Extract imported names from a CJS variable_declarator node.
 * - `const x = require('…')` → `["default"]`
 * - `const { a, b } = require('…')` → `["a", "b"]`
 * - `const { a: renamed } = require('…')` → `["a"]`
 */
function extractRequireNames(declarator: TreeSitterNode): string[] {
  const nameNode = declarator.childForFieldName("name");
  if (!nameNode) return [];

  if (nameNode.type === "identifier") {
    return ["default"];
  }

  if (nameNode.type === "object_pattern") {
    const names: string[] = [];
    for (const prop of nameNode.namedChildren) {
      if (prop.type === "shorthand_property_identifier_pattern") {
        names.push(prop.text);
      } else if (prop.type === "pair_pattern") {
        // const { original: alias } = require('...') → extract "original"
        const key = prop.childForFieldName("key");
        if (key) names.push(key.text);
      }
    }
    return names;
  }

  return [];
}

/**
 * Resolve an import specifier to a file path in the known file set.
 *
 * For relative imports (./foo, ../bar), resolves against the importer's directory.
 * For non-relative imports (@org/pkg, pkg/sub), checks packageRoots to resolve
 * cross-repo references. Falls back to the raw specifier if no match is found.
 */
export function resolveImportSpecifier(
  specifier: string,
  importerPath: string,
  knownPaths: ReadonlySet<string>,
  packageRoots?: ReadonlyMap<string, string>,
): string {
  // Handle @/ path alias (common tsconfig paths convention: "@/*" -> "src/*")
  if (specifier.startsWith("@/")) {
    const aliasPath = "src/" + specifier.slice(2);
    // Also try resolving relative to the importer's root (no src/ prefix)
    const resolved = probeExtensions(aliasPath, knownPaths);
    if (resolved) return resolved;
    // Try without src/ prefix (alias might map to project root directly)
    const resolvedRoot = probeExtensions(specifier.slice(2), knownPaths);
    if (resolvedRoot) return resolvedRoot;
  }

  // Non-relative imports: try packageRoots first, then return as-is
  if (!specifier.startsWith(".")) {
    if (packageRoots) {
      const resolved = resolvePackageImport(specifier, knownPaths, packageRoots);
      if (resolved) return resolved;
    }
    return specifier;
  }

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

  return probeExtensions(base, knownPaths) ?? specifier;
}

const EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

function probeExtensions(base: string, knownPaths: ReadonlySet<string>): string | undefined {
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (knownPaths.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve a non-relative import against known package roots.
 * Handles exact package matches ("@org/pkg") and subpath imports ("@org/pkg/sub").
 */
function resolvePackageImport(
  specifier: string,
  knownPaths: ReadonlySet<string>,
  packageRoots: ReadonlyMap<string, string>,
): string | undefined {
  // Try exact match first
  const root = packageRoots.get(specifier);
  if (root) {
    const resolved = probeExtensions(root + "/src/index", knownPaths);
    if (resolved) return resolved;
  }

  // Try stripping subpath: "@org/pkg/sub/path" -> "@org/pkg" + "sub/path"
  // Handle scoped packages (@org/pkg) and plain packages (pkg)
  let pkgName: string;
  let subpath: string;
  if (specifier.startsWith("@")) {
    // Scoped: find the third slash for subpath
    const secondSlash = specifier.indexOf("/", specifier.indexOf("/") + 1);
    if (secondSlash === -1) return undefined; // Already tried exact match above
    pkgName = specifier.slice(0, secondSlash);
    subpath = specifier.slice(secondSlash + 1);
  } else {
    const firstSlash = specifier.indexOf("/");
    if (firstSlash === -1) return undefined; // Already tried exact match above
    pkgName = specifier.slice(0, firstSlash);
    subpath = specifier.slice(firstSlash + 1);
  }

  const pkgRoot = packageRoots.get(pkgName);
  if (!pkgRoot) return undefined;

  // Try resolving subpath under the package root's src/ directory
  const base = pkgRoot + "/src/" + subpath;
  return probeExtensions(base, knownPaths) ?? undefined;
}

export function findCircularDependencies(edges: readonly GraphEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }

  const cycles: string[][] = [];
  // 3-color DFS (Tarjan-style):
  // WHITE = not yet visited (not in either set)
  // GRAY  = on the current DFS stack (in `stack` but not yet in `visited`)
  // BLACK = fully processed (in `visited`)
  //
  // A back-edge to a GRAY node indicates a cycle.
  // BLACK nodes are guaranteed cycle-free from that node onward — skip them.
  // The key fix vs the naive approach: we only move a node to BLACK (visited)
  // AFTER all its neighbors have been processed. Adding to visited on entry
  // (before processing neighbors) conflates GRAY and BLACK, causing cycles to
  // be missed when a node is reached via a non-cyclic path before a cyclic one.
  const visited = new Set<string>();
  const stack = new Set<string>();

  const path: string[] = [];

  function dfs(node: string): void {
    if (stack.has(node)) {
      // Back-edge to a GRAY node — we found a cycle
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }
    if (visited.has(node)) return; // BLACK — already fully processed

    // Mark GRAY: on the current stack
    stack.add(node);
    path.push(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      dfs(neighbor);
    }

    path.pop();
    stack.delete(node);
    // Mark BLACK: fully processed
    visited.add(node);
  }

  for (const node of adjacency.keys()) {
    dfs(node);
  }

  return cycles;
}

/** A dependency cycle with optional barrel-mediation metadata. */
export interface AnnotatedCycle {
  /** The nodes in the cycle (file IDs in `repo:path` format from `makeFileId`). */
  readonly cycle: string[];
  /**
   * True when at least one node in the cycle is a barrel file (index.ts/index.js
   * whose entire body consists of re-export statements).  These cycles are
   * structural artifacts of the barrel pattern and are typically false-positive
   * circular-dependency warnings.
   */
  readonly barrelMediated: boolean;
}

/**
 * Determine whether a file is a barrel — every top-level construct is either a
 * re-export (`export * from '…'` / `export { X } from '…'`) or an import
 * statement (type-only imports for barrel files are common).  The file must
 * also contain at least one re-export to qualify.
 *
 * Non-barrel exports (inline exports of locally defined symbols such as
 * `export class Foo {}` or `export const x = …`) cause the function to return
 * false.
 */
export function isBarrelFile(tree: TreeSitterTree): boolean {
  const root = tree.rootNode;
  let hasReexport = false;

  for (const child of root.namedChildren) {
    switch (child.type) {
      case "import_statement":
      case "comment":
        // Allowed: type-only imports and comments don't disqualify a barrel.
        continue;
      case "export_statement": {
        // Re-export: must have a "source" field (the `from '…'` clause).
        const sourceNode = child.childForFieldName("source");
        if (sourceNode) {
          hasReexport = true;
        } else {
          // Inline export of a local declaration — not a re-export.
          return false;
        }
        break;
      }
      default:
        // Any other top-level node (variable declaration, class, function, …)
        // means this file is not a pure barrel.
        return false;
    }
  }

  return hasReexport;
}

/**
 * Given the set of file trees and the cycles produced by
 * `findCircularDependencies`, annotate each cycle with a `barrelMediated` flag.
 *
 * @param cycles    Raw cycles as returned by `findCircularDependencies`.
 * @param files     The same file map passed to `extractDependencyGraph`.
 * @param repo      Repository name (used to decode `repo:path` file IDs).
 * @returns         Annotated cycles in the same order as the input.
 */
export function tagBarrelMediatedCycles(
  cycles: readonly string[][],
  files: ReadonlyMap<string, TreeSitterTree>,
  repo: string,
): AnnotatedCycle[] {
  // Build a set of paths that are barrel files for O(1) lookup.
  const barrelPaths = new Set<string>();
  for (const [filePath, tree] of files) {
    const basename = filePath.split("/").pop() ?? "";
    if (
      (basename === "index.ts" || basename === "index.js" ||
       basename === "index.tsx" || basename === "index.jsx") &&
      isBarrelFile(tree)
    ) {
      barrelPaths.add(filePath);
    }
  }

  const prefix = repo + ":";

  return cycles.map((cycle) => {
    const barrelMediated = cycle.some((nodeId) => {
      // nodeId is either `repo:path` (internal, from makeFileId) or a bare
      // package name (external).  Strip the repo prefix to recover the file path.
      const path = nodeId.startsWith(prefix)
        ? nodeId.slice(prefix.length)
        : nodeId;
      return barrelPaths.has(path);
    });
    return { cycle, barrelMediated };
  });
}

/**
 * Returns the set of barrel file paths (index.ts/js files whose body is
 * entirely re-exports) from the given file map.
 */
export function getBarrelPaths(
  files: ReadonlyMap<string, TreeSitterTree>,
): string[] {
  const barrelPaths: string[] = [];
  for (const [filePath, tree] of files) {
    const basename = filePath.split("/").pop() ?? "";
    if (
      (basename === "index.ts" || basename === "index.js" ||
       basename === "index.tsx" || basename === "index.jsx") &&
      isBarrelFile(tree)
    ) {
      barrelPaths.push(filePath);
    }
  }
  return barrelPaths;
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
