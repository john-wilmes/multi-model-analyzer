/**
 * Log co-occurrence analysis. (log-cooccurrence.test.ts)
 *
 * Groups log templates that tend to fire together based on:
 * - Same-function proximity (strongest signal)
 * - Same-file proximity
 * - Call-graph connectivity
 * - Backward-trace edge overlap
 */

import type { LogTemplateIndex, LogTemplate, CallGraph } from "@mma/core";
import type { BackwardTrace } from "./backward-trace.js";

export interface LogCoOccurrenceGroup {
  readonly id: string;
  readonly templates: readonly LogTemplate[];
  readonly relationship: "same-function" | "same-file" | "call-connected" | "trace-overlap";
  readonly score: number; // 0-1, confidence that these logs fire together
  readonly sharedContext?: string; // e.g., "database", "network" if templates share context
}

export interface LogCoOccurrenceResult {
  readonly repo: string;
  readonly groups: readonly LogCoOccurrenceGroup[];
}

type Relationship = LogCoOccurrenceGroup["relationship"];

interface Pair {
  readonly aIdx: number;
  readonly bIdx: number;
  readonly relationship: Relationship;
  readonly score: number;
}

const RELATIONSHIP_SCORE: Record<Relationship, number> = {
  "same-function": 0.9,
  "trace-overlap": 0.7,
  "same-file": 0.6,
  "call-connected": 0.4,
};

// -------------------------------------------------------------------
// Union-Find
// -------------------------------------------------------------------
function makeUnionFind(n: number): { find: (x: number) => number; union: (a: number, b: number) => void } {
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array<number>(n).fill(0);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!; // path compression
      x = parent[x]!;
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra]! < rank[rb]!) {
      parent[ra] = rb;
    } else if (rank[ra]! > rank[rb]!) {
      parent[rb] = ra;
    } else {
      parent[rb] = ra;
      rank[ra] = rank[ra]! + 1;
    }
  }

  return { find, union };
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

/**
 * Extract the file path from a fullyQualifiedName ("filePath:lineNumber").
 * Falls back to the module field.
 */
function extractFilePath(module: string, fqn?: string): string {
  if (!fqn) return module;
  const colonIdx = fqn.lastIndexOf(":");
  if (colonIdx <= 0) return module;
  return fqn.slice(0, colonIdx);
}

/**
 * Extract the line number from a fullyQualifiedName ("filePath:lineNumber").
 * Returns NaN when not parseable.
 */
function extractLineNumber(fqn?: string): number {
  if (!fqn) return NaN;
  const colonIdx = fqn.lastIndexOf(":");
  if (colonIdx < 0) return NaN;
  return parseInt(fqn.slice(colonIdx + 1), 10);
}

/**
 * Infer a shared context label for a group from its templates' text.
 */
function inferSharedContext(templates: readonly LogTemplate[]): string | undefined {
  const contextKeywords: Array<[string, string]> = [
    ["database", "database"],
    ["query", "database"],
    ["sql", "database"],
    ["http", "network"],
    ["request", "network"],
    ["api", "network"],
    ["auth", "authentication"],
    ["token", "authentication"],
    ["permission", "authentication"],
    ["file", "filesystem"],
    ["disk", "filesystem"],
    ["memory", "memory"],
    ["heap", "memory"],
  ];

  // Count how many templates match each context (deduplicate per template)
  const counts = new Map<string, number>();
  for (const tmpl of templates) {
    const text = tmpl.template.toLowerCase();
    const matched = new Set<string>();
    for (const [keyword, context] of contextKeywords) {
      if (text.includes(keyword)) {
        matched.add(context);
      }
    }
    for (const ctx of matched) {
      counts.set(ctx, (counts.get(ctx) ?? 0) + 1);
    }
  }

  // Only return a context if it appears in at least half the templates
  const threshold = Math.max(1, Math.ceil(templates.length / 2));
  let best: string | undefined;
  let bestCount = 0;
  for (const [ctx, count] of counts) {
    if (count >= threshold && count > bestCount) {
      best = ctx;
      bestCount = count;
    }
  }
  return best;
}

// -------------------------------------------------------------------
// Main analysis
// -------------------------------------------------------------------

export function analyzeLogCoOccurrence(
  logIndex: LogTemplateIndex,
  callGraph: CallGraph,
  traces: readonly BackwardTrace[],
): LogCoOccurrenceResult {
  const templates = logIndex.templates;
  if (templates.length < 2) {
    return { repo: logIndex.repo, groups: [] };
  }

  // Build trace edge sets for each template (union across all traces for that template)
  const traceEdgeSets = new Map<string, Set<string>>();
  for (const trace of traces) {
    const tmplId = trace.root.template.id;
    if (!traceEdgeSets.has(tmplId)) {
      traceEdgeSets.set(tmplId, new Set());
    }
    const edgeSet = traceEdgeSets.get(tmplId)!;
    for (const edge of trace.tracedEdges) {
      edgeSet.add(`${edge.from}→${edge.to}`);
    }
  }

  // Build call graph adjacency (bidirectional) for "call-connected" check
  const callAdj = new Map<string, Set<string>>();
  for (const edge of callGraph.edges) {
    if (!callAdj.has(edge.source)) callAdj.set(edge.source, new Set());
    callAdj.get(edge.source)!.add(edge.target);
    if (!callAdj.has(edge.target)) callAdj.set(edge.target, new Set());
    callAdj.get(edge.target)!.add(edge.source);
  }

  const pairs: Pair[] = [];

  for (let i = 0; i < templates.length; i++) {
    for (let j = i + 1; j < templates.length; j++) {
      const a = templates[i]!;
      const b = templates[j]!;

      // Skip duplicate template text
      if (a.template === b.template) continue;

      const pair = classifyPair(a, b, traceEdgeSets, callAdj);
      if (pair) {
        pairs.push({ aIdx: i, bIdx: j, ...pair });
      }
    }
  }

  if (pairs.length === 0) {
    return { repo: logIndex.repo, groups: [] };
  }

  // Cluster using union-find
  const uf = makeUnionFind(templates.length);
  for (const pair of pairs) {
    uf.union(pair.aIdx, pair.bIdx);
  }

  // For each group root, find the best (highest-score) relationship across all pairs within the group
  const groupRootToBest = new Map<number, { relationship: Relationship; score: number }>();
  for (const pair of pairs) {
    const root = uf.find(pair.aIdx);
    const existing = groupRootToBest.get(root);
    if (!existing || pair.score > existing.score) {
      groupRootToBest.set(root, { relationship: pair.relationship, score: pair.score });
    }
  }

  // Collect members for each group root
  const groupMap = new Map<number, number[]>();
  for (let i = 0; i < templates.length; i++) {
    const root = uf.find(i);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root)!.push(i);
  }

  // Only emit groups with 2+ templates (singletons have no pair, won't be in groupRootToBest)
  const groups: LogCoOccurrenceGroup[] = [];
  let groupCounter = 0;

  for (const [root, indices] of groupMap) {
    if (indices.length < 2) continue;
    const best = groupRootToBest.get(root);
    if (!best) continue; // no pair within this group (shouldn't happen, but guard)

    const groupTemplates = indices.map((idx) => templates[idx]!);
    const sharedCtx = inferSharedContext(groupTemplates);

    const group: LogCoOccurrenceGroup = {
      id: `cooccur-${logIndex.repo}-${groupCounter++}`,
      templates: groupTemplates,
      relationship: best.relationship,
      score: best.score,
      ...(sharedCtx !== undefined ? { sharedContext: sharedCtx } : {}),
    };
    groups.push(group);
  }

  return { repo: logIndex.repo, groups };
}

// -------------------------------------------------------------------
// Pair classification
// -------------------------------------------------------------------

function classifyPair(
  a: LogTemplate,
  b: LogTemplate,
  traceEdgeSets: ReadonlyMap<string, ReadonlySet<string>>,
  callAdj: ReadonlyMap<string, ReadonlySet<string>>,
): { relationship: Relationship; score: number } | null {
  // Gather all (module, lines[]) info for each template
  const aModules = new Set<string>();
  const bModules = new Set<string>();
  const aLines = new Map<string, number[]>(); // module → lines (multiple locations)
  const bLines = new Map<string, number[]>();

  for (const loc of a.locations) {
    aModules.add(loc.module);
    const line = extractLineNumber(loc.fullyQualifiedName);
    if (!isNaN(line)) {
      const arr = aLines.get(loc.module);
      if (arr) arr.push(line); else aLines.set(loc.module, [line]);
    }
    const file = extractFilePath(loc.module, loc.fullyQualifiedName);
    if (file !== loc.module) aModules.add(file);
  }
  for (const loc of b.locations) {
    bModules.add(loc.module);
    const line = extractLineNumber(loc.fullyQualifiedName);
    if (!isNaN(line)) {
      const arr = bLines.get(loc.module);
      if (arr) arr.push(line); else bLines.set(loc.module, [line]);
    }
    const file = extractFilePath(loc.module, loc.fullyQualifiedName);
    if (file !== loc.module) bModules.add(file);
  }

  // 1. Same-function: same module AND any pair of lines within 20 of each other
  for (const mod of aModules) {
    if (bModules.has(mod)) {
      const aLs = aLines.get(mod);
      const bLs = bLines.get(mod);
      if (aLs && bLs) {
        for (const al of aLs) {
          for (const bl of bLs) {
            if (Math.abs(al - bl) <= 20) {
              return { relationship: "same-function", score: RELATIONSHIP_SCORE["same-function"] };
            }
          }
        }
      }
    }
  }

  // 2. Trace overlap: >30% shared CFG edges
  const aEdges = traceEdgeSets.get(a.id);
  const bEdges = traceEdgeSets.get(b.id);
  if (aEdges && aEdges.size > 0 && bEdges && bEdges.size > 0) {
    let shared = 0;
    for (const e of aEdges) {
      if (bEdges.has(e)) shared++;
    }
    const overlapRatio = shared / (aEdges.size + bEdges.size - shared);
    if (overlapRatio > 0.3) {
      return { relationship: "trace-overlap", score: RELATIONSHIP_SCORE["trace-overlap"] };
    }
  }

  // 3. Same-file: same module path but not same-function (lines too far apart or missing)
  for (const mod of aModules) {
    if (bModules.has(mod)) {
      return { relationship: "same-file", score: RELATIONSHIP_SCORE["same-file"] };
    }
  }

  // 4. Call-connected: any location's module is adjacent in call graph
  for (const aMod of aModules) {
    const neighbors = callAdj.get(aMod);
    if (neighbors) {
      for (const bMod of bModules) {
        if (neighbors.has(bMod)) {
          return { relationship: "call-connected", score: RELATIONSHIP_SCORE["call-connected"] };
        }
      }
    }
  }

  return null;
}
