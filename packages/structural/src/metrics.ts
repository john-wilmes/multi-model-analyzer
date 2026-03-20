/**
 * Module instability metrics (Robert C. Martin's package coupling metrics).
 *
 * Computes per-module:
 * - Ca (afferent coupling): how many modules import this one (fan-in)
 * - Ce (efferent coupling): how many modules this one imports (fan-out)
 * - Instability: Ce / (Ca + Ce), 0 = maximally stable, 1 = maximally unstable
 * - Abstractness: ratio of abstract symbols (interfaces + types) to total symbols
 * - Distance from main sequence: |A + I - 1|, 0 = ideal
 * - Zone classification: pain (low I, low A), uselessness (high I, high A), etc.
 */

import type { GraphEdge, ParsedFile, ModuleMetrics, RepoMetricsSummary, MetricZone, SarifResult } from "@mma/core";
import { makeFileId } from "@mma/core";

export function computeModuleMetrics(
  edges: readonly GraphEdge[],
  parsedFiles: readonly ParsedFile[],
  repo: string,
): ModuleMetrics[] {
  // Count Ca (afferent) and Ce (efferent) per module using import edges.
  // Also seed `modules` here to avoid a second pass over importEdges later.
  const importEdges = edges.filter((e) => e.kind === "imports");
  const caCount = new Map<string, Set<string>>();
  const ceCount = new Map<string, Set<string>>();
  const modules = new Set<string>();

  for (const edge of importEdges) {
    // Ce: source imports target -> source has efferent coupling
    let ce = ceCount.get(edge.source);
    if (!ce) { ce = new Set(); ceCount.set(edge.source, ce); }
    ce.add(edge.target);

    // Ca: target is imported by source -> target has afferent coupling
    let ca = caCount.get(edge.target);
    if (!ca) { ca = new Set(); caCount.set(edge.target, ca); }
    ca.add(edge.source);

    // Collect modules seen in edges (merged from the former separate loop)
    modules.add(edge.source);
    modules.add(edge.target);
  }

  // Build precomputed abstractness counts while seeding the modules set from
  // parsedFiles.  Counting here (O(symbols) once per file) avoids a filter
  // call inside the per-module loop below.
  //
  // W8: Only count top-level symbols (no containerName) to normalize the ratio.
  // Methods/properties are children of classes and would inflate totalSymbols
  // without a matching abstract contribution, skewing abstractness toward 0.
  //
  // W7: Count abstract classes (isAbstract=true) in addition to interfaces and
  // type aliases.  The isAbstract flag is set by the ts-morph parser; tree-sitter
  // does not distinguish abstract classes, so those files will under-count until
  // ts-morph is enabled.
  const abstractCountByFile = new Map<string, number>();
  const totalCountByFile = new Map<string, number>();
  for (const pf of parsedFiles) {
    const fileId = makeFileId(repo, pf.path);
    modules.add(fileId);
    let total = 0;
    let count = 0;
    for (const s of pf.symbols) {
      if (s.containerName) continue; // skip non-top-level symbols (W8)
      total++;
      if (s.kind === "interface" || s.kind === "type" || s.isAbstract) count++; // W7
    }
    totalCountByFile.set(fileId, total);
    abstractCountByFile.set(fileId, count);
  }

  const results: ModuleMetrics[] = [];
  for (const mod of modules) {
    const ca = caCount.get(mod)?.size ?? 0;
    const ce = ceCount.get(mod)?.size ?? 0;
    const instability = ca + ce === 0 ? 0 : ce / (ca + ce);

    const totalSymbols = totalCountByFile.get(mod) ?? 0;
    const abstractSymbols = abstractCountByFile.get(mod) ?? 0;
    const abstractness = totalSymbols === 0 ? 0 : abstractSymbols / totalSymbols;

    const distance = Math.abs(abstractness + instability - 1);
    const zone = classifyZone(instability, abstractness);

    results.push({ module: mod, repo, ca, ce, instability, abstractness, distance, zone });
  }

  return results;
}

function classifyZone(instability: number, abstractness: number): MetricZone {
  // W9: The 0.3/0.7 thresholds below originate from Robert C. Martin's 1997
  // paper "OO Design Quality Metrics" (derived from Java package coupling).
  // They are widely cited but empirically unvalidated for TypeScript codebases,
  // where file-level granularity, structural typing, and heavy use of type
  // aliases make direct translation uncertain. Treat zone classifications as
  // heuristic signals rather than precise measurements.

  // Pain zone: high stability (low I) + low abstractness -> hard to change
  if (instability < 0.3 && abstractness < 0.3) return "pain";
  // Uselessness zone: high instability + high abstractness -> over-abstracted
  if (instability > 0.7 && abstractness > 0.7) return "uselessness";
  // Near main sequence (A + I close to 1)
  const distance = Math.abs(abstractness + instability - 1);
  if (distance < 0.3) return "main-sequence";
  return "balanced";
}

/**
 * Detect Stable Dependencies Principle violations and zone anomalies.
 *
 * - SDP violation: module A depends on module B where B is significantly more unstable than A.
 * - Pain zone: concrete module with many dependents (hard to change).
 * - Uselessness zone: over-abstracted module with few dependents.
 */
export function detectInstabilityViolations(
  metrics: readonly ModuleMetrics[],
  importEdges: readonly GraphEdge[],
  repo: string,
  options?: { sdpThreshold?: number },
): SarifResult[] {
  const threshold = options?.sdpThreshold ?? 0.3;
  const results: SarifResult[] = [];

  // Build a lookup from module path to its metrics
  const metricsByModule = new Map<string, ModuleMetrics>();
  for (const m of metrics) {
    metricsByModule.set(m.module, m);
  }

  // SDP violations: for each import edge, check if source (importer) is more stable
  // than target (dependency) by more than the threshold.
  // Group violations by source module and emit one result per source.
  const edges = importEdges.filter((e) => e.kind === "imports");

  interface ViolatingDep {
    target: string;
    srcInstability: number;
    tgtInstability: number;
    delta: number;
  }
  const violationsBySource = new Map<string, ViolatingDep[]>();

  for (const edge of edges) {
    const src = metricsByModule.get(edge.source);
    const tgt = metricsByModule.get(edge.target);
    if (!src || !tgt) continue;

    // Skip barrel files (index.ts/js) — they are naturally unstable
    // (high Ce from re-exports) but that instability is by design, not a defect.
    if (isBarrelFile(edge.target)) continue;

    const delta = tgt.instability - src.instability;
    if (delta > threshold) {
      let list = violationsBySource.get(edge.source);
      if (!list) { list = []; violationsBySource.set(edge.source, list); }
      list.push({ target: edge.target, srcInstability: src.instability, tgtInstability: tgt.instability, delta });
    }
  }

  for (const [source, violations] of violationsBySource) {
    const src = metricsByModule.get(source)!;
    const depList = violations
      .map((v) => `${v.target} (I=${v.tgtInstability.toFixed(2)}, delta=${v.delta.toFixed(2)})`)
      .join(", ");
    results.push({
      ruleId: "structural/unstable-dependency",
      level: "warning",
      message: {
        text: `${source} (I=${src.instability.toFixed(2)}) depends on ${violations.length} unstable module(s): ${depList}`,
      },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: source },
        },
        logicalLocations: [{
          fullyQualifiedName: source,
          kind: "module",
          properties: { repo },
        }],
      }],
    });
  }

  // Zone anomalies
  for (const m of metrics) {
    // Gate pain-zone notes on ca > 0: orphan files (ca=0, ce=0) satisfy
    // instability < 0.3 && abstractness < 0.3 but have no dependents, so
    // flagging them as "hard to change" is misleading — nobody depends on them.
    if (m.zone === "pain" && m.ca > 0 && !isBarrelFile(m.module)) {
      results.push({
        ruleId: "structural/pain-zone-module",
        level: "note",
        message: {
          text: `${m.module} is in the pain zone (I=${m.instability.toFixed(2)}, A=${m.abstractness.toFixed(2)}): concrete and stable, hard to change`,
        },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: m.module },
          },
          logicalLocations: [{
            fullyQualifiedName: m.module,
            kind: "module",
            properties: { repo },
          }],
        }],
      });
    } else if (m.zone === "uselessness") {
      results.push({
        ruleId: "structural/uselessness-zone-module",
        level: "note",
        message: {
          text: `${m.module} is in the uselessness zone (I=${m.instability.toFixed(2)}, A=${m.abstractness.toFixed(2)}): over-abstracted with few dependents`,
        },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: m.module },
          },
          logicalLocations: [{
            fullyQualifiedName: m.module,
            kind: "module",
            properties: { repo },
          }],
        }],
      });
    }
  }

  return results;
}

export function summarizeRepoMetrics(
  modules: readonly ModuleMetrics[],
  repo: string,
): RepoMetricsSummary {
  if (modules.length === 0) {
    return {
      repo,
      moduleCount: 0,
      avgInstability: 0,
      avgAbstractness: 0,
      avgDistance: 0,
      painZoneCount: 0,
      uselessnessZoneCount: 0,
    };
  }

  const sumI = modules.reduce((s, m) => s + m.instability, 0);
  const sumA = modules.reduce((s, m) => s + m.abstractness, 0);
  const sumD = modules.reduce((s, m) => s + m.distance, 0);

  return {
    repo,
    moduleCount: modules.length,
    avgInstability: sumI / modules.length,
    avgAbstractness: sumA / modules.length,
    avgDistance: sumD / modules.length,
    painZoneCount: modules.filter((m) => m.zone === "pain").length,
    uselessnessZoneCount: modules.filter((m) => m.zone === "uselessness").length,
  };
}

const BARREL_RE = /(?:^|[/\\])index\.[jt]sx?$/;
function isBarrelFile(moduleId: string): boolean {
  return BARREL_RE.test(moduleId);
}
