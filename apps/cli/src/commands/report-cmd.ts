/**
 * `mma report` — Generate an anonymized field trial report.
 *
 * Reads a populated DB (read-only) and produces a JSON and/or Markdown
 * report containing aggregate statistics with all repo names, file paths,
 * and symbol names stripped or hashed.
 */

import { writeFile } from "node:fs/promises";
import type {
  EdgeKind,
  ModuleMetrics,
  RepoMetricsSummary,
  SarifLog,
} from "@mma/core";
import type { KVStore, GraphStore } from "@mma/storage";
import { discoverRepos } from "@mma/storage";
import { redactSarifLog } from "@mma/diagnostics";
import { printTable } from "../formatter.js";
import type { ReportFormat } from "../formatter.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReportOptions {
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly output?: string;
  readonly format: ReportFormat;
  readonly includeSarif: boolean;
  readonly salt: string;
  readonly note?: string;
}

export interface FieldTrialReport {
  readonly schemaVersion: "1.0";
  readonly generatedAt: string;
  readonly note?: string;
  readonly repoCount: number;
  readonly pipeline: PipelineHealth;
  readonly metrics: MetricsSummarySection;
  readonly diagnostics: DiagnosticsSummarySection;
  readonly graph: GraphTopologySection;
  readonly patterns: PatternSummarySection;
  readonly quality: QualityAssessment;
  readonly sarif?: object;
}

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

interface PipelineHealth {
  readonly repos: readonly RepoPipelineStatus[];
}

interface RepoPipelineStatus {
  readonly label: string;
  readonly phases: Record<string, "present" | "empty" | "missing">;
}

interface MetricsSummarySection {
  readonly aggregate: AggregateMetrics | null;
  readonly perRepo: readonly RepoMetricsEntry[];
}

interface AggregateMetrics {
  readonly moduleCount: number;
  readonly avgInstability: number;
  readonly avgAbstractness: number;
  readonly avgDistance: number;
  readonly instabilityQuartiles: Quartiles;
  readonly abstractnessQuartiles: Quartiles;
  readonly zoneHistogram: Record<string, number>;
}

interface Quartiles {
  readonly q0: number;
  readonly q1: number;
  readonly q2: number;
  readonly q3: number;
  readonly q4: number;
}

interface RepoMetricsEntry {
  readonly label: string;
  readonly moduleCount: number;
  readonly avgInstability: number;
  readonly avgAbstractness: number;
  readonly avgDistance: number;
  readonly painZoneCount: number;
  readonly uselessnessZoneCount: number;
  readonly zoneHistogram: Record<string, number>;
}

interface DiagnosticsSummarySection {
  readonly totalFindings: number;
  readonly byRuleId: Record<string, number>;
  readonly byLevel: Record<string, number>;
}

interface GraphTopologySection {
  readonly byKind: Record<string, EdgeKindStats>;
}

interface EdgeKindStats {
  readonly edgeCount: number;
  readonly nodeCount: number;
  readonly avgFanIn: number;
  readonly avgFanOut: number;
}

interface PatternSummarySection {
  readonly totalPatterns: number;
  readonly byKind: Record<string, number>;
}

type CapabilityStatus = "produced-data" | "ran-empty" | "not-run";

interface QualityAssessment {
  readonly capabilities: Record<string, CapabilityStatus>;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function reportCommand(options: ReportOptions): Promise<FieldTrialReport> {
  const { kvStore, graphStore, format, output, includeSarif, salt, note } = options;

  // 1. Discover repos and assign anonymous labels
  const repoMap = await discoverAnonymizedRepos(kvStore);
  const repoNames = [...repoMap.keys()];

  // 2. Collect sections
  const [pipeline, metrics, diagnostics, graph, patterns] = await Promise.all([
    collectPipelineHealth(kvStore, repoMap),
    collectMetrics(kvStore, repoMap),
    collectDiagnostics(kvStore),
    collectGraphTopology(graphStore, repoNames),
    collectPatterns(kvStore, repoMap),
  ]);

  const quality = assessQuality(pipeline, metrics, diagnostics, graph, patterns);

  // 3. Optional redacted SARIF
  let sarif: object | undefined;
  if (includeSarif) {
    sarif = await collectRedactedSarif(kvStore, salt);
  }

  const report: FieldTrialReport = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    note: note ?? undefined,
    repoCount: repoNames.length,
    pipeline,
    metrics,
    diagnostics,
    graph,
    patterns,
    quality,
    ...(sarif ? { sarif } : {}),
  };

  // 4. Output
  if (format === "sarif") {
    const sarifData = await collectRedactedSarif(kvStore, salt);
    if (sarifData) {
      const sarifStr = JSON.stringify(sarifData, null, 2);
      if (output) {
        await writeFile(output, sarifStr, "utf-8");
        console.log(`SARIF report written to ${output}`);
      } else {
        console.log(sarifStr);
      }
    } else {
      console.log("No SARIF data available. Run 'index' first.");
    }
    return report;
  }

  if (format === "table") {
    console.log(`Report: ${report.repoCount} repo(s), generated ${report.generatedAt}`);

    // Per-repo metrics table
    if (report.metrics.perRepo.length > 0) {
      console.log("\nPer-Repo Metrics:");
      printTable(
        ["Repo", "Modules", "Instability", "Abstractness", "Distance", "Pain", "Uselessness"],
        report.metrics.perRepo.map((r) => [
          r.label,
          String(r.moduleCount),
          String(r.avgInstability),
          String(r.avgAbstractness),
          String(r.avgDistance),
          String(r.painZoneCount),
          String(r.uselessnessZoneCount),
        ]),
      );
    }

    // Diagnostics by rule table
    if (Object.keys(report.diagnostics.byRuleId).length > 0) {
      console.log(`\nDiagnostics (${report.diagnostics.totalFindings} total):`);
      printTable(
        ["Rule ID", "Count"],
        Object.entries(report.diagnostics.byRuleId).map(([rule, count]) => [rule, String(count)]),
      );
    }

    // Graph topology table
    if (Object.keys(report.graph.byKind).length > 0) {
      console.log("\nGraph Topology:");
      printTable(
        ["Kind", "Edges", "Nodes", "Avg Fan-In", "Avg Fan-Out"],
        Object.entries(report.graph.byKind).map(([kind, stats]) => [
          kind,
          String(stats.edgeCount),
          String(stats.nodeCount),
          String(stats.avgFanIn),
          String(stats.avgFanOut),
        ]),
      );
    }

    // Capability status table
    console.log("\nCapabilities:");
    printTable(
      ["Capability", "Status"],
      Object.entries(report.quality.capabilities).map(([cap, status]) => [cap, status]),
    );

    return report;
  }

  if (output) {
    if (format === "json" || format === "both") {
      const jsonStr = JSON.stringify(report, null, 2);
      await writeFile(output, jsonStr, "utf-8");
      console.log(`JSON report written to ${output}`);
    }
    if (format === "markdown" || format === "both") {
      const md = renderMarkdown(report);
      const mdPath = output.replace(/\.json$/, "") + ".md";
      await writeFile(mdPath, md, "utf-8");
      console.log(`Markdown report written to ${mdPath}`);
    }
  } else if (format === "markdown") {
    console.log(renderMarkdown(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  return report;
}

// ---------------------------------------------------------------------------
// Repo discovery
// ---------------------------------------------------------------------------

async function discoverAnonymizedRepos(kvStore: KVStore): Promise<Map<string, string>> {
  const repos = await discoverRepos(kvStore);
  const repoMap = new Map<string, string>();
  repos.forEach((name, i) => repoMap.set(name, `repo-${i + 1}`));
  return repoMap;
}

// ---------------------------------------------------------------------------
// Pipeline health
// ---------------------------------------------------------------------------

const PIPELINE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["commit:", "commit"],
  ["symbols:", "symbols"],
  ["metrics:", "metrics"],
  ["metricsSummary:", "metricsSummary"],
  ["patterns:", "patterns"],
  ["circularDeps:", "circularDeps"],
  ["faultTrees:", "faultTrees"],
  ["docs:functional:", "docs"],
];

async function collectPipelineHealth(
  kvStore: KVStore,
  repoMap: Map<string, string>,
): Promise<PipelineHealth> {
  const repos: RepoPipelineStatus[] = [];

  for (const [repoName, label] of repoMap) {
    const phases: Record<string, "present" | "empty" | "missing"> = {};

    for (const [prefix, phaseName] of PIPELINE_KEYS) {
      // For symbols, check prefix:repo: pattern
      if (prefix === "symbols:") {
        const keys = await kvStore.keys(`${prefix}${repoName}:`);
        phases[phaseName] = keys.length > 0 ? "present" : "missing";
      } else {
        const val = await kvStore.get(`${prefix}${repoName}`);
        if (val === undefined) {
          phases[phaseName] = "missing";
        } else {
          // Check if value is an empty array or object
          try {
            const parsed: unknown = JSON.parse(val);
            if (Array.isArray(parsed) && parsed.length === 0) {
              phases[phaseName] = "empty";
            } else if (typeof parsed === "object" && parsed !== null && Object.keys(parsed as Record<string, unknown>).length === 0) {
              phases[phaseName] = "empty";
            } else {
              phases[phaseName] = "present";
            }
          } catch {
            phases[phaseName] = val ? "present" : "empty";
          }
        }
      }
    }

    // Check SARIF keys
    const sarifCategories = ["config", "fault", "deadExports", "arch", "instability"];
    let sarifCount = 0;
    for (const cat of sarifCategories) {
      const val = await kvStore.get(`sarif:${cat}:${repoName}`);
      if (val) {
        try {
          const parsed = JSON.parse(val) as unknown[];
          if (parsed.length > 0) sarifCount++;
        } catch { /* skip */ }
      }
    }
    phases["sarif"] = sarifCount > 0 ? "present" : "missing";

    repos.push({ label, phases });
  }

  return { repos };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function computeQuartiles(values: number[]): Quartiles {
  if (values.length === 0) return { q0: 0, q1: 0, q2: 0, q3: 0, q4: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p: number) => {
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo]!;
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
  };
  return {
    q0: sorted[0]!,
    q1: round4(pct(25)),
    q2: round4(pct(50)),
    q3: round4(pct(75)),
    q4: sorted[sorted.length - 1]!,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

async function collectMetrics(
  kvStore: KVStore,
  repoMap: Map<string, string>,
): Promise<MetricsSummarySection> {
  const perRepo: RepoMetricsEntry[] = [];
  const allInstabilities: number[] = [];
  const allAbstractness: number[] = [];
  const globalZones: Record<string, number> = {};
  let totalModules = 0;
  let sumInstability = 0;
  let sumAbstractness = 0;
  let sumDistance = 0;

  for (const [repoName, label] of repoMap) {
    const summaryJson = await kvStore.get(`metricsSummary:${repoName}`);
    if (!summaryJson) continue;

    let summary: RepoMetricsSummary;
    try {
      summary = JSON.parse(summaryJson) as RepoMetricsSummary;
    } catch { continue; }
    const zoneHistogram: Record<string, number> = {};

    // Read per-module metrics for distributions
    const metricsJson = await kvStore.get(`metrics:${repoName}`);
    if (metricsJson) {
      let modules: ModuleMetrics[];
      try {
        modules = JSON.parse(metricsJson) as ModuleMetrics[];
      } catch { continue; }
      for (const m of modules) {
        allInstabilities.push(m.instability);
        allAbstractness.push(m.abstractness);
        zoneHistogram[m.zone] = (zoneHistogram[m.zone] ?? 0) + 1;
        globalZones[m.zone] = (globalZones[m.zone] ?? 0) + 1;
      }
    }

    totalModules += summary.moduleCount;
    sumInstability += summary.avgInstability * summary.moduleCount;
    sumAbstractness += summary.avgAbstractness * summary.moduleCount;
    sumDistance += summary.avgDistance * summary.moduleCount;

    perRepo.push({
      label,
      moduleCount: summary.moduleCount,
      avgInstability: summary.avgInstability,
      avgAbstractness: summary.avgAbstractness,
      avgDistance: summary.avgDistance,
      painZoneCount: summary.painZoneCount,
      uselessnessZoneCount: summary.uselessnessZoneCount,
      zoneHistogram,
    });
  }

  const aggregate: AggregateMetrics | null =
    totalModules > 0
      ? {
          moduleCount: totalModules,
          avgInstability: round4(sumInstability / totalModules),
          avgAbstractness: round4(sumAbstractness / totalModules),
          avgDistance: round4(sumDistance / totalModules),
          instabilityQuartiles: computeQuartiles(allInstabilities),
          abstractnessQuartiles: computeQuartiles(allAbstractness),
          zoneHistogram: globalZones,
        }
      : null;

  return { aggregate, perRepo };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

async function collectDiagnostics(
  kvStore: KVStore,
): Promise<DiagnosticsSummarySection> {
  const byRuleId: Record<string, number> = {};
  const byLevel: Record<string, number> = {};
  let totalFindings = 0;

  const sarifJson = await kvStore.get("sarif:latest");
  if (sarifJson) {
    let sarif: SarifLog;
    try {
      sarif = JSON.parse(sarifJson) as SarifLog;
    } catch {
      return { totalFindings: 0, byRuleId: {}, byLevel: {} };
    }
    for (const run of sarif.runs) {
      for (const result of run.results) {
        totalFindings++;
        byRuleId[result.ruleId] = (byRuleId[result.ruleId] ?? 0) + 1;
        byLevel[result.level] = (byLevel[result.level] ?? 0) + 1;
      }
    }
  }

  return { totalFindings, byRuleId, byLevel };
}

// ---------------------------------------------------------------------------
// Graph topology
// ---------------------------------------------------------------------------

const EDGE_KINDS: readonly EdgeKind[] = [
  "imports",
  "calls",
  "extends",
  "implements",
  "depends-on",
  "contains",
  "service-call",
];

async function collectGraphTopology(
  graphStore: GraphStore,
  repoNames: readonly string[],
): Promise<GraphTopologySection> {
  const byKind: Record<string, EdgeKindStats> = {};

  for (const kind of EDGE_KINDS) {
    let totalEdges = 0;
    const sourceCount = new Map<string, number>();
    const targetCount = new Map<string, number>();

    for (const repo of repoNames) {
      const edges = await graphStore.getEdgesByKind(kind, repo);
      totalEdges += edges.length;
      for (const e of edges) {
        sourceCount.set(e.source, (sourceCount.get(e.source) ?? 0) + 1);
        targetCount.set(e.target, (targetCount.get(e.target) ?? 0) + 1);
      }
    }

    if (totalEdges === 0) continue;

    const allNodes = new Set([...sourceCount.keys(), ...targetCount.keys()]);
    const nodeCount = allNodes.size;
    const avgFanOut =
      nodeCount > 0
        ? round4([...sourceCount.values()].reduce((a, b) => a + b, 0) / nodeCount)
        : 0;
    const avgFanIn =
      nodeCount > 0
        ? round4([...targetCount.values()].reduce((a, b) => a + b, 0) / nodeCount)
        : 0;

    byKind[kind] = { edgeCount: totalEdges, nodeCount, avgFanIn, avgFanOut };
  }

  return { byKind };
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

async function collectPatterns(
  kvStore: KVStore,
  repoMap: Map<string, string>,
): Promise<PatternSummarySection> {
  const byKind: Record<string, number> = {};
  let totalPatterns = 0;

  for (const [repoName] of repoMap) {
    const json = await kvStore.get(`patterns:${repoName}`);
    if (!json) continue;
    try {
      const patterns = JSON.parse(json) as Array<{ kind: string }>;
      for (const p of patterns) {
        totalPatterns++;
        byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
      }
    } catch { /* skip malformed */ }
  }

  return { totalPatterns, byKind };
}

// ---------------------------------------------------------------------------
// Quality assessment
// ---------------------------------------------------------------------------

function assessQuality(
  pipeline: PipelineHealth,
  metrics: MetricsSummarySection,
  diagnostics: DiagnosticsSummarySection,
  graph: GraphTopologySection,
  patterns: PatternSummarySection,
): QualityAssessment {
  const capabilities: Record<string, CapabilityStatus> = {};

  // Symbols
  const hasSymbols = pipeline.repos.some((r) => r.phases["symbols"] === "present");
  capabilities["symbol-extraction"] = hasSymbols ? "produced-data" : "not-run";

  // Metrics
  capabilities["module-metrics"] =
    metrics.aggregate !== null ? "produced-data" : metrics.perRepo.length > 0 ? "ran-empty" : "not-run";

  // Diagnostics
  capabilities["diagnostics"] =
    diagnostics.totalFindings > 0 ? "produced-data" : "ran-empty";

  // Dependency graph
  capabilities["dependency-graph"] =
    (graph.byKind["imports"]?.edgeCount ?? 0) > 0 ? "produced-data" : "not-run";

  // Call graph
  capabilities["call-graph"] =
    (graph.byKind["calls"]?.edgeCount ?? 0) > 0 ? "produced-data" : "not-run";

  // Patterns
  capabilities["pattern-detection"] =
    patterns.totalPatterns > 0 ? "produced-data" : "ran-empty";

  // Docs
  const hasDocs = pipeline.repos.some((r) => r.phases["docs"] === "present");
  capabilities["documentation"] = hasDocs ? "produced-data" : "not-run";

  // Fault trees
  const hasFaults = pipeline.repos.some((r) => r.phases["faultTrees"] === "present");
  capabilities["fault-trees"] = hasFaults ? "produced-data" : "not-run";

  return { capabilities };
}

// ---------------------------------------------------------------------------
// Redacted SARIF
// ---------------------------------------------------------------------------

async function collectRedactedSarif(
  kvStore: KVStore,
  salt: string,
): Promise<object | undefined> {
  const json = await kvStore.get("sarif:latest");
  if (!json) return undefined;

  let sarif: SarifLog;
  try {
    sarif = JSON.parse(json) as SarifLog;
  } catch {
    return undefined;
  }
  return redactSarifLog(sarif, {
    salt,
    redactFilePaths: true,
    preserveRuleIds: true,
    preserveStatistics: true,
  });
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

export function renderMarkdown(report: FieldTrialReport): string {
  const lines: string[] = [];
  const push = (...s: string[]) => lines.push(...s);

  push("# Field Trial Report", "");
  push(`Generated: ${report.generatedAt}`, "");
  if (report.note) push(`> ${report.note}`, "");
  push(`**Repositories analyzed:** ${report.repoCount}`, "");

  // --- Pipeline Health ---
  push("## Pipeline Health", "");
  if (report.pipeline.repos.length > 0) {
    const phases = Object.keys(report.pipeline.repos[0]!.phases);
    push(`| Repo | ${phases.join(" | ")} |`);
    push(`| --- | ${phases.map(() => "---").join(" | ")} |`);
    for (const repo of report.pipeline.repos) {
      const vals = phases.map((p) => statusIcon(repo.phases[p]!));
      push(`| ${repo.label} | ${vals.join(" | ")} |`);
    }
    push("");
  }

  // --- Quality Assessment ---
  push("## Quality Assessment", "");
  const caps = report.quality.capabilities;
  push("| Capability | Status |");
  push("| --- | --- |");
  for (const [cap, status] of Object.entries(caps)) {
    push(`| ${cap} | ${status} |`);
  }
  push("");

  // --- Metrics ---
  push("## Metrics Summary", "");
  if (report.metrics.aggregate) {
    const a = report.metrics.aggregate;
    push(`- **Total modules:** ${a.moduleCount}`);
    push(`- **Avg instability:** ${a.avgInstability}`);
    push(`- **Avg abstractness:** ${a.avgAbstractness}`);
    push(`- **Avg distance:** ${a.avgDistance}`);
    push("");
    push("### Instability Quartiles", "");
    push(`Q0=${a.instabilityQuartiles.q0}, Q1=${a.instabilityQuartiles.q1}, Q2=${a.instabilityQuartiles.q2}, Q3=${a.instabilityQuartiles.q3}, Q4=${a.instabilityQuartiles.q4}`, "");
    push("### Zone Histogram", "");
    for (const [zone, count] of Object.entries(a.zoneHistogram)) {
      push(`- ${zone}: ${count}`);
    }
    push("");
  } else {
    push("No metrics data available.", "");
  }

  if (report.metrics.perRepo.length > 0) {
    push("### Per-Repo Metrics", "");
    push("| Repo | Modules | Instability | Abstractness | Distance | Pain | Uselessness |");
    push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const r of report.metrics.perRepo) {
      push(`| ${r.label} | ${r.moduleCount} | ${r.avgInstability} | ${r.avgAbstractness} | ${r.avgDistance} | ${r.painZoneCount} | ${r.uselessnessZoneCount} |`);
    }
    push("");
  }

  // --- Diagnostics ---
  push("## Diagnostics", "");
  push(`**Total findings:** ${report.diagnostics.totalFindings}`, "");
  if (Object.keys(report.diagnostics.byRuleId).length > 0) {
    push("### By Rule", "");
    push("| Rule ID | Count |");
    push("| --- | --- |");
    for (const [rule, count] of Object.entries(report.diagnostics.byRuleId)) {
      push(`| ${rule} | ${count} |`);
    }
    push("");
  }
  if (Object.keys(report.diagnostics.byLevel).length > 0) {
    push("### By Severity", "");
    push("| Level | Count |");
    push("| --- | --- |");
    for (const [level, count] of Object.entries(report.diagnostics.byLevel)) {
      push(`| ${level} | ${count} |`);
    }
    push("");
  }

  // --- Graph Topology ---
  push("## Graph Topology", "");
  if (Object.keys(report.graph.byKind).length > 0) {
    push("| Kind | Edges | Nodes | Avg Fan-In | Avg Fan-Out |");
    push("| --- | --- | --- | --- | --- |");
    for (const [kind, stats] of Object.entries(report.graph.byKind)) {
      push(`| ${kind} | ${stats.edgeCount} | ${stats.nodeCount} | ${stats.avgFanIn} | ${stats.avgFanOut} |`);
    }
    push("");
  } else {
    push("No graph data available.", "");
  }

  // --- Patterns ---
  push("## Pattern Detection", "");
  push(`**Total patterns:** ${report.patterns.totalPatterns}`, "");
  if (Object.keys(report.patterns.byKind).length > 0) {
    push("| Kind | Count |");
    push("| --- | --- |");
    for (const [kind, count] of Object.entries(report.patterns.byKind)) {
      push(`| ${kind} | ${count} |`);
    }
    push("");
  }

  // --- SARIF ---
  if (report.sarif) {
    push("## Redacted SARIF", "");
    push("Redacted SARIF data is available in the JSON output.", "");
  }

  return lines.join("\n");
}

function statusIcon(status: string): string {
  switch (status) {
    case "present":
      return "OK";
    case "empty":
      return "empty";
    case "missing":
      return "-";
    default:
      return "?";
  }
}
