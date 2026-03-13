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
  const abstractCountByFile = new Map<string, number>();
  const totalCountByFile = new Map<string, number>();
  for (const pf of parsedFiles) {
    modules.add(pf.path);
    totalCountByFile.set(pf.path, pf.symbols.length);
    let count = 0;
    for (const s of pf.symbols) {
      if (s.kind === "interface" || s.kind === "type") count++;
    }
    abstractCountByFile.set(pf.path, count);
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
  // than target (dependency) by more than the threshold
  const edges = importEdges.filter((e) => e.kind === "imports");
  for (const edge of edges) {
    const src = metricsByModule.get(edge.source);
    const tgt = metricsByModule.get(edge.target);
    if (!src || !tgt) continue;

    const delta = tgt.instability - src.instability;
    if (delta > threshold) {
      results.push({
        ruleId: "structural/unstable-dependency",
        level: "warning",
        message: {
          text: `${edge.source} (I=${src.instability.toFixed(2)}) depends on ${edge.target} (I=${tgt.instability.toFixed(2)}): stable module depends on unstable module (delta=${delta.toFixed(2)}, threshold=${threshold})`,
        },
        locations: [{
          logicalLocations: [{
            fullyQualifiedName: `${edge.source}->${edge.target}`,
            kind: "module",
            properties: { repo },
          }],
        }],
      });
    }
  }

  // Zone anomalies
  for (const m of metrics) {
    // Gate pain-zone notes on ca > 0: orphan files (ca=0, ce=0) satisfy
    // instability < 0.3 && abstractness < 0.3 but have no dependents, so
    // flagging them as "hard to change" is misleading — nobody depends on them.
    if (m.zone === "pain" && m.ca > 0) {
      results.push({
        ruleId: "structural/pain-zone-module",
        level: "note",
        message: {
          text: `${m.module} is in the pain zone (I=${m.instability.toFixed(2)}, A=${m.abstractness.toFixed(2)}): concrete and stable, hard to change`,
        },
        locations: [{
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
