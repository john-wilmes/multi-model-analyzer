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

import type { GraphEdge, ParsedFile, ModuleMetrics, RepoMetricsSummary, MetricZone } from "@mma/core";

export function computeModuleMetrics(
  edges: readonly GraphEdge[],
  parsedFiles: readonly ParsedFile[],
  repo: string,
): ModuleMetrics[] {
  // Count Ca (afferent) and Ce (efferent) per module using import edges
  const importEdges = edges.filter((e) => e.kind === "imports");
  const caCount = new Map<string, Set<string>>();
  const ceCount = new Map<string, Set<string>>();

  for (const edge of importEdges) {
    // Ce: source imports target -> source has efferent coupling
    let ce = ceCount.get(edge.source);
    if (!ce) { ce = new Set(); ceCount.set(edge.source, ce); }
    ce.add(edge.target);

    // Ca: target is imported by source -> target has afferent coupling
    let ca = caCount.get(edge.target);
    if (!ca) { ca = new Set(); caCount.set(edge.target, ca); }
    ca.add(edge.source);
  }

  // Collect all modules (files with symbols)
  const modules = new Set<string>();
  for (const pf of parsedFiles) modules.add(pf.path);
  for (const edge of importEdges) {
    modules.add(edge.source);
    modules.add(edge.target);
  }

  // Build symbol lookup for abstractness
  const symbolsByFile = new Map<string, ParsedFile["symbols"]>();
  for (const pf of parsedFiles) {
    symbolsByFile.set(pf.path, pf.symbols);
  }

  const results: ModuleMetrics[] = [];
  for (const mod of modules) {
    const ca = caCount.get(mod)?.size ?? 0;
    const ce = ceCount.get(mod)?.size ?? 0;
    const instability = ca + ce === 0 ? 0 : ce / (ca + ce);

    const symbols = symbolsByFile.get(mod) ?? [];
    const totalSymbols = symbols.length;
    const abstractSymbols = symbols.filter(
      (s) => s.kind === "interface" || s.kind === "type",
    ).length;
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
