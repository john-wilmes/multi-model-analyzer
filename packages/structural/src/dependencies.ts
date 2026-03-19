/**
 * Dependency graph extraction via module-level import analysis.
 *
 * For POC: direct import/require parsing from AST.
 * For scale: dependency-cruiser integration for circular detection and rule violations.
 */

import { makeFileId } from "@mma/core";
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
  packageRoots?: ReadonlyMap<string, string>,
  repoRoot?: string,
): DependencyGraph {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const edges: GraphEdge[] = [];
  const knownPaths = new Set(files.keys());

  // Relativize absolute packageRoots for probing against relative knownPaths
  let localRoots = packageRoots;
  if (packageRoots && repoRoot) {
    const prefix = repoRoot.endsWith("/") ? repoRoot : repoRoot + "/";
    const relMap = new Map<string, string>();
    for (const [name, dir] of packageRoots) {
      if (dir.startsWith(prefix)) {
        relMap.set(name, dir.slice(prefix.length));
      }
    }
    if (relMap.size > 0) localRoots = relMap;
  }

  for (const [filePath, tree] of files) {
    const imports = extractImports(tree.rootNode);
    for (const imp of imports) {
      if (opts.ignorePatterns.some((p) => imp.includes(p))) continue;
      const resolved = resolveImportSpecifier(imp, filePath, knownPaths, localRoots);
      // Use canonical ID for local files so source and target share the same
      // namespace (enabling cycle detection). External specifiers stay as-is.
      const target = knownPaths.has(resolved) ? makeFileId(repo, resolved) : resolved;
      edges.push({
        source: makeFileId(repo, filePath),
        target,
        kind: "imports",
        metadata: { repo },
      });
    }
  }

  const circularDependencies = opts.detectCircular
    ? findCircularDependencies(edges)
    : [];

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

function extractImports(rootNode: TreeSitterNode): string[] {
  const imports: string[] = [];

  for (const child of rootNode.namedChildren) {
    if (child.type === "import_statement") {
      const source = findStringLiteral(child);
      if (source) imports.push(stripLoaderPrefix(source));
    } else if (child.type === "expression_statement") {
      // Handle require() calls
      const req = findRequireCall(child);
      if (req) imports.push(stripLoaderPrefix(req));
    } else if (child.type === "export_statement") {
      // Handle re-exports: export * from './x', export { X } from './x'
      // Use the "source" field to avoid matching strings inside exported class/function bodies
      const sourceNode = (child as any).childForFieldName?.("source");
      if (sourceNode) {
        const source = findStringLiteral(sourceNode);
        if (source) imports.push(stripLoaderPrefix(source));
      }
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
  const visited = new Set<string>();
  const stack = new Set<string>();

  const path: string[] = [];

  function dfs(node: string): void {
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
      dfs(neighbor);
    }

    path.pop();
    stack.delete(node);
  }

  for (const node of adjacency.keys()) {
    dfs(node);
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
