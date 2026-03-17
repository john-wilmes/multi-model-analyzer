/**
 * `mma practices` — Generate a prioritized best-practices report.
 *
 * Reads SARIF findings and metrics from a KVStore and produces an actionable
 * report with prioritized findings, structural health, and recommendations.
 * Output is for the repo owner; real repo names are used (not anonymized).
 */

import type { KVStore } from "@mma/storage";
import { discoverRepos } from "@mma/storage";
import type { SarifLog, SarifResult, RepoMetricsSummary } from "@mma/core";
import type { ReportFormat } from "../formatter.js";
import { formatTable } from "../formatter.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PracticesOptions {
  readonly kvStore: KVStore;
  readonly format: ReportFormat;
  readonly output?: string;
  readonly topN?: number;
  readonly silent?: boolean;
}

export interface PracticesReport {
  readonly schemaVersion: string;
  readonly generatedAt: string;
  readonly repoCount: number;
  readonly executive: ExecutiveSummary;
  readonly findings: PrioritizedFindings;
  readonly structural: StructuralHealth;
  readonly scorecard: CategoryScorecard;
  readonly recommendations: Recommendation[];
  readonly atdi: AtdiScore;
  readonly debt: DebtEstimate;
}

export interface DebtEstimate {
  totalDebtMinutes: number;
  totalDebtHours: number;   // totalDebtMinutes / 60, rounded to 1 decimal
  byCategory: DebtCategoryEstimate[];
  byRule: DebtRuleEstimate[];  // top 10 by debt contribution
}

export interface DebtCategoryEstimate {
  category: string;
  debtMinutes: number;
  debtHours: number;
  findingCount: number;
}

export interface DebtRuleEstimate {
  ruleId: string;
  category: string;
  findingCount: number;
  minutesPerInstance: number;
  totalMinutes: number;
}

export interface ExecutiveSummary {
  readonly grade: string;
  readonly score: number;
  readonly headline: string;
  readonly topActions: string[];
}

export interface PrioritizedFindings {
  readonly fixNow: FindingGroup[];
  readonly planFor: FindingGroup[];
  readonly monitor: FindingGroup[];
}

export interface FindingGroup {
  readonly ruleId: string;
  readonly category: string;
  readonly count: number;
  readonly level: string;
  readonly priorityScore: number;
  readonly interpretation: string;
  readonly action: string;
  readonly hasNew: boolean;
}

export interface StructuralHealth {
  readonly repos: RepoHealthEntry[];
}

export interface RepoHealthEntry {
  readonly repo: string;
  readonly moduleCount: number;
  readonly avgDistance: number;
  readonly distanceRating: string;
  readonly painZonePct: number;
  readonly painRating: string;
  readonly uselessnessPct: number;
  readonly uselessnessRating: string;
}

export type CategoryScorecard = CategoryRow[];

export interface CategoryRow {
  readonly category: string;
  readonly healthScore: number;
  readonly stars: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly noteCount: number;
  readonly total: number;
}

export interface Recommendation {
  readonly priority: number;
  readonly title: string;
  readonly rationale: string;
  readonly effort: string;
  readonly guideRef?: string;
}

export interface AtdiScore {
  score: number;           // 0-100, higher = healthier (lower debt)
  trend: "worsening" | "stable" | "improving";
  newFindingCount: number;
  totalFindingCount: number;
  categoryBreakdown: AtdiCategoryBreakdown[];
}

export interface AtdiCategoryBreakdown {
  category: string;
  contribution: number;    // points toward total score
  findingDensity: number;  // weighted findings per module
}

// ---------------------------------------------------------------------------
// Rule metadata
// ---------------------------------------------------------------------------

interface RuleMeta {
  readonly category: string;
  readonly interpretation: string;
  readonly action: string;
  readonly guideRef: string;
  readonly effort: "low" | "medium" | "high";
  readonly categoryWeight: number;
  readonly debtMinutes: number;
}

const CATEGORY_WEIGHTS: Record<string, number> = {
  vulnerability: 30,
  fault: 20,
  architecture: 10,
  structural: 5,
  config: 5,
  "blast-radius": 0,
  temporal: 8,
  hotspot: 15,
};

const RULE_METADATA: Record<string, RuleMeta> = {
  "config/dead-flag": {
    category: "config",
    interpretation: "Feature flag can never be enabled — dead code.",
    action: "Remove the flag and its guarded code paths.",
    guideRef: "`config/dead-flag` in findings-guide.md",
    effort: "low",
    categoryWeight: CATEGORY_WEIGHTS["config"]!,
    debtMinutes: 15,
  },
  "config/always-on-flag": {
    category: "config",
    interpretation: "Feature flag is always enabled, making it effectively unconditional code.",
    action: "Remove the flag and inline the always-on branch permanently.",
    guideRef: "`config/always-on-flag` in findings-guide.md",
    effort: "low",
    categoryWeight: CATEGORY_WEIGHTS["config"]!,
    debtMinutes: 15,
  },
  "config/missing-constraint": {
    category: "config",
    interpretation: "Feature flag has no declared type constraint or allowed values.",
    action: "Add an explicit type annotation or allowed-values constraint to the flag.",
    guideRef: "`config/missing-constraint` in findings-guide.md",
    effort: "low",
    categoryWeight: CATEGORY_WEIGHTS["config"]!,
    debtMinutes: 20,
  },
  "config/untested-interaction": {
    category: "config",
    interpretation: "Two feature flags interact but no test covers their combined state.",
    action: "Add a test covering the flag combination, or document that interaction is intentionally unsupported.",
    guideRef: "`config/untested-interaction` in findings-guide.md",
    effort: "medium",
    categoryWeight: CATEGORY_WEIGHTS["config"]!,
    debtMinutes: 90,
  },
  "config/format-violation": {
    category: "config",
    interpretation: "Configuration value does not conform to its declared format or schema.",
    action: "Fix the malformed configuration value and add schema validation to prevent regression.",
    guideRef: "`config/format-violation` in findings-guide.md",
    effort: "low",
    categoryWeight: CATEGORY_WEIGHTS["config"]!,
    debtMinutes: 15,
  },
  "fault/unhandled-error-path": {
    category: "fault",
    interpretation: "An async call or promise rejection is not handled, leaving a latent crash path.",
    action: "Add a try/catch or .catch() handler; propagate or log the error explicitly.",
    guideRef: "`fault/unhandled-error-path` in findings-guide.md",
    effort: "low",
    categoryWeight: CATEGORY_WEIGHTS["fault"]!,
    debtMinutes: 30,
  },
  "fault/silent-failure": {
    category: "fault",
    interpretation: "An error is caught but swallowed without logging or re-throwing.",
    action: "Log the error at minimum, or propagate it to the caller.",
    guideRef: "`fault/silent-failure` in findings-guide.md",
    effort: "low",
    categoryWeight: CATEGORY_WEIGHTS["fault"]!,
    debtMinutes: 20,
  },
  "fault/missing-error-boundary": {
    category: "fault",
    interpretation: "A component or service boundary lacks an error boundary, so failures escape containment.",
    action: "Add an error boundary (React ErrorBoundary, middleware handler, or top-level try/catch) at the boundary.",
    guideRef: "`fault/missing-error-boundary` in findings-guide.md",
    effort: "medium",
    categoryWeight: CATEGORY_WEIGHTS["fault"]!,
    debtMinutes: 120,
  },
  "fault/cascading-failure-risk": {
    category: "fault",
    interpretation: "A module is on a critical dependency path where a single failure can propagate broadly.",
    action: "Add a circuit breaker, bulkhead, or graceful degradation path for this dependency.",
    guideRef: "`fault/cascading-failure-risk` in findings-guide.md",
    effort: "high",
    categoryWeight: CATEGORY_WEIGHTS["fault"]!,
    debtMinutes: 480,
  },
  "structural/dead-export": {
    category: "structural",
    interpretation: "An exported symbol is never imported anywhere in the codebase.",
    action: "Remove the export, or mark it with a comment if it is part of a public API.",
    guideRef: "`structural/dead-export` in findings-guide.md",
    effort: "low",
    categoryWeight: CATEGORY_WEIGHTS["structural"]!,
    debtMinutes: 15,
  },
  "structural/unstable-dependency": {
    category: "structural",
    interpretation: "A stable module depends on an unstable one, inverting the expected dependency direction.",
    action: "Introduce an abstraction layer or inversion-of-control boundary to isolate the unstable module.",
    guideRef: "`structural/unstable-dependency` in findings-guide.md",
    effort: "medium",
    categoryWeight: CATEGORY_WEIGHTS["structural"]!,
    debtMinutes: 120,
  },
  "structural/pain-zone-module": {
    category: "structural",
    interpretation: "Module is both highly unstable and highly abstract — difficult to change and tightly coupled.",
    action: "Reduce coupling (lower abstractness) or stabilize the module's dependencies.",
    guideRef: "`structural/pain-zone-module` in findings-guide.md",
    effort: "high",
    categoryWeight: CATEGORY_WEIGHTS["structural"]!,
    debtMinutes: 240,
  },
  "structural/uselessness-zone-module": {
    category: "structural",
    interpretation: "Module is highly abstract but has no dependents — over-engineered dead weight.",
    action: "Collapse the abstraction into its concrete implementations or remove it entirely.",
    guideRef: "`structural/uselessness-zone-module` in findings-guide.md",
    effort: "medium",
    categoryWeight: CATEGORY_WEIGHTS["structural"]!,
    debtMinutes: 60,
  },
  "arch/layer-violation": {
    category: "architecture",
    interpretation: "A module imports from a layer it should not depend on according to your layer rules.",
    action: "Refactor the dependency to flow through the correct layer boundary.",
    guideRef: "`arch/layer-violation` in findings-guide.md",
    effort: "medium",
    categoryWeight: CATEGORY_WEIGHTS["architecture"]!,
    debtMinutes: 90,
  },
  "arch/forbidden-import": {
    category: "architecture",
    interpretation: "A module imports a symbol that is explicitly forbidden by architectural policy.",
    action: "Remove the forbidden import and use the approved alternative.",
    guideRef: "`arch/forbidden-import` in findings-guide.md",
    effort: "low",
    categoryWeight: CATEGORY_WEIGHTS["architecture"]!,
    debtMinutes: 30,
  },
  "arch/dependency-direction": {
    category: "architecture",
    interpretation: "A dependency points against the declared architecture's allowed direction.",
    action: "Invert the dependency using an interface or event, or move the code to the correct layer.",
    guideRef: "`arch/dependency-direction` in findings-guide.md",
    effort: "medium",
    categoryWeight: CATEGORY_WEIGHTS["architecture"]!,
    debtMinutes: 120,
  },
  "temporal-coupling/co-change": {
    category: "temporal",
    interpretation: "Two files change together frequently, indicating a hidden dependency.",
    action: "Co-locate the files, extract a shared abstraction, or document the coupling.",
    guideRef: "`temporal-coupling/co-change` in findings-guide.md",
    effort: "medium",
    categoryWeight: CATEGORY_WEIGHTS["temporal"]!,
    debtMinutes: 45,
  },
  "vuln/reachable-dependency": {
    category: "vulnerability",
    interpretation: "A dependency with known vulnerabilities is imported in your code.",
    action: "Update the dependency to a patched version, or replace it with a safe alternative.",
    guideRef: "`vuln/reachable-dependency` in findings-guide.md",
    effort: "low",
    categoryWeight: CATEGORY_WEIGHTS["vulnerability"]!,
    debtMinutes: 30,
  },
  "blast-radius/high-pagerank": {
    category: "blast-radius",
    interpretation: "Module has high graph centrality — changes here affect a large portion of the codebase.",
    action: "Stabilize this module's public API and add integration tests to catch regressions early.",
    guideRef: "`blast-radius/high-pagerank` in findings-guide.md",
    effort: "medium",
    categoryWeight: CATEGORY_WEIGHTS["blast-radius"]!,
    debtMinutes: 60,
  },
  "hotspot/high-churn-complexity": {
    category: "hotspot",
    interpretation: "File is frequently modified and has high complexity — a prime candidate for bugs and difficult maintenance.",
    action: "Consider refactoring into smaller modules, increasing test coverage, or establishing code ownership.",
    guideRef: "`hotspot/high-churn-complexity` in findings-guide.md",
    effort: "high",
    categoryWeight: CATEGORY_WEIGHTS["hotspot"]!,
    debtMinutes: 240,
  },
};

const DEFAULT_META: RuleMeta = {
  category: "unknown",
  interpretation: "An issue was detected by a custom or unknown rule.",
  action: "Review the finding and consult the rule documentation.",
  guideRef: "findings-guide.md",
  effort: "medium",
  categoryWeight: 0,
  debtMinutes: 60,
};

function inferCategoryFromRuleId(ruleId: string): string {
  if (ruleId.startsWith("vuln/")) return "vulnerability";
  if (ruleId.startsWith("fault/")) return "fault";
  if (ruleId.startsWith("arch/")) return "architecture";
  if (ruleId.startsWith("structural/")) return "structural";
  if (ruleId.startsWith("config/")) return "config";
  if (ruleId.startsWith("temporal-coupling/")) return "temporal";
  if (ruleId.startsWith("blast-radius/")) return "blast-radius";
  return "unknown";
}

function getMeta(ruleId: string): RuleMeta {
  const known = RULE_METADATA[ruleId];
  if (known) return known;
  const category = inferCategoryFromRuleId(ruleId);
  const categoryWeight = CATEGORY_WEIGHTS[category] ?? 0;
  return { ...DEFAULT_META, category, categoryWeight };
}

// ---------------------------------------------------------------------------
// Repo discovery
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function scoreToGrade(score: number): string {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

function gradeHeadline(grade: string, score: number): string {
  const base = `Codebase health: ${grade} (${score}/100)`;
  switch (grade) {
    case "A": return `${base} — healthy codebase with minimal technical debt.`;
    case "B": return `${base} — generally sound with some areas to address.`;
    case "C": return `${base} — moderate issues present; targeted improvements recommended.`;
    case "D": return `${base} — significant issues detected; prioritize structural remediation.`;
    default:   return `${base} — critical issues require immediate attention.`;
  }
}

function buildExecutiveSummary(
  results: readonly SarifResult[],
  structural: StructuralHealth,
): ExecutiveSummary {
  let score = 100;

  for (const r of results) {
    if (r.level === "error") score -= 15;
    else if (r.level === "warning") score -= 3;
  }

  if (structural.repos.length > 0) {
    const avgDist =
      structural.repos.reduce((s, r) => s + r.avgDistance, 0) / structural.repos.length;
    const avgPain =
      structural.repos.reduce((s, r) => s + r.painZonePct, 0) / structural.repos.length;
    score -= avgDist * 20;
    score -= (avgPain / 100) * 10;
  }

  score = Math.round(Math.max(0, Math.min(100, score)));
  const grade = scoreToGrade(score);
  const headline = gradeHeadline(grade, score);

  return { grade, score, headline, topActions: [] };
}

function levelSeverityWeight(level: string): number {
  if (level === "error") return 100;
  if (level === "warning") return 60;
  return 20;
}

function prioritizeFindings(results: readonly SarifResult[]): PrioritizedFindings {
  // Group by ruleId
  const groups = new Map<
    string,
    { level: string; count: number; hasNew: boolean }
  >();

  for (const r of results) {
    const existing = groups.get(r.ruleId);
    const hasNew = r.baselineState === "new";
    if (existing) {
      existing.count++;
      if (hasNew) existing.hasNew = true;
    } else {
      groups.set(r.ruleId, { level: r.level, count: 1, hasNew });
    }
  }

  const findingGroups: FindingGroup[] = [];

  for (const [ruleId, g] of groups) {
    const meta = getMeta(ruleId);
    const severityWeight = levelSeverityWeight(g.level);
    const frequencyWeight = Math.min(g.count, 50);
    const newBonus = g.hasNew ? 15 : 0;
    const priorityScore =
      severityWeight + frequencyWeight + meta.categoryWeight + newBonus;

    findingGroups.push({
      ruleId,
      category: meta.category,
      count: g.count,
      level: g.level,
      priorityScore,
      interpretation: meta.interpretation,
      action: meta.action,
      hasNew: g.hasNew,
    });
  }

  findingGroups.sort((a, b) => b.priorityScore - a.priorityScore);

  const fixNow = findingGroups.filter((g) => g.priorityScore >= 80);
  const planFor = findingGroups.filter((g) => g.priorityScore >= 40 && g.priorityScore < 80);
  const monitor = findingGroups.filter((g) => g.priorityScore < 40);

  return { fixNow, planFor, monitor };
}

async function assessStructuralHealth(
  kvStore: KVStore,
  repos: readonly string[],
): Promise<StructuralHealth> {
  const entries: RepoHealthEntry[] = [];

  for (const repo of repos) {
    const json = await kvStore.get(`metricsSummary:${repo}`);
    if (!json) continue;

    let summary: RepoMetricsSummary;
    try {
      summary = JSON.parse(json) as RepoMetricsSummary;
    } catch {
      continue;
    }

    const { moduleCount, avgDistance, painZoneCount, uselessnessZoneCount } = summary;

    const painZonePct = moduleCount > 0 ? (painZoneCount / moduleCount) * 100 : 0;
    const uselessnessPct = moduleCount > 0 ? (uselessnessZoneCount / moduleCount) * 100 : 0;

    const distanceRating =
      avgDistance < 0.2 ? "good" : avgDistance < 0.4 ? "warning" : "critical";
    const painRating =
      painZonePct < 10 ? "good" : painZonePct < 25 ? "warning" : "critical";
    const uselessnessRating =
      uselessnessPct < 5 ? "good" : uselessnessPct < 15 ? "warning" : "critical";

    entries.push({
      repo,
      moduleCount,
      avgDistance: Math.round(avgDistance * 1000) / 1000,
      distanceRating,
      painZonePct: Math.round(painZonePct * 10) / 10,
      painRating,
      uselessnessPct: Math.round(uselessnessPct * 10) / 10,
      uselessnessRating,
    });
  }

  return { repos: entries };
}

function buildScorecard(results: readonly SarifResult[]): CategoryScorecard {
  const byCategory = new Map<
    string,
    { errors: number; warnings: number; notes: number }
  >();

  for (const r of results) {
    const { category } = getMeta(r.ruleId);
    const existing = byCategory.get(category) ?? { errors: 0, warnings: 0, notes: 0 };
    if (r.level === "error") existing.errors++;
    else if (r.level === "warning") existing.warnings++;
    else existing.notes++;
    byCategory.set(category, existing);
  }

  const rows: CategoryRow[] = [];

  for (const [category, counts] of byCategory) {
    const { errors, warnings, notes } = counts;
    const rawScore =
      5 -
      Math.floor(errors / 2) -
      Math.floor(warnings / 5) -
      Math.floor(notes / 10) * 0.5;
    const healthScore = Math.max(1, Math.round(rawScore));
    const stars = "★".repeat(healthScore) + "☆".repeat(5 - healthScore);
    rows.push({
      category,
      healthScore,
      stars,
      errorCount: errors,
      warningCount: warnings,
      noteCount: notes,
      total: errors + warnings + notes,
    });
  }

  rows.sort((a, b) => a.healthScore - b.healthScore);
  return rows;
}

function synthesizeRecommendations(
  findings: PrioritizedFindings,
  structural: StructuralHealth,
): Recommendation[] {
  const recs: Recommendation[] = [];

  // Up to 4 from fixNow tier
  const fixNowSlice = findings.fixNow.slice(0, 4);
  for (let i = 0; i < fixNowSlice.length; i++) {
    const g = fixNowSlice[i]!;
    const meta = getMeta(g.ruleId);
    recs.push({
      priority: recs.length + 1,
      title: `Fix ${g.ruleId} (${g.count} occurrence${g.count !== 1 ? "s" : ""})`,
      rationale: `${g.interpretation} Found in ${g.count} location${g.count !== 1 ? "s" : ""} — priority score ${g.priorityScore}.`,
      effort: meta.effort,
      guideRef: meta.guideRef,
    });
  }

  // Structural distance / pain zone recommendation
  const hasCriticalStructure = structural.repos.some(
    (r) => r.distanceRating === "critical" || r.painRating === "critical",
  );
  if (hasCriticalStructure && recs.length < 7) {
    recs.push({
      priority: recs.length + 1,
      title: "Reduce structural pain zones",
      rationale:
        "One or more repos have modules far from the main sequence or in the pain zone. These modules are both unstable and abstract — they are hard to change and contribute to systemic fragility.",
      effort: "high",
      guideRef: "`structural/pain-zone-module` in findings-guide.md",
    });
  }

  // Over-abstraction recommendation
  const hasCriticalUselessness = structural.repos.some(
    (r) => r.uselessnessRating === "critical",
  );
  if (hasCriticalUselessness && recs.length < 7) {
    recs.push({
      priority: recs.length + 1,
      title: "Collapse over-abstracted modules",
      rationale:
        "One or more repos have a high proportion of modules in the uselessness zone — highly abstract but with no dependents. These add indirection without delivering reuse value.",
      effort: "medium",
      guideRef: "`structural/uselessness-zone-module` in findings-guide.md",
    });
  }

  return recs.slice(0, 7);
}

function computeDebtEstimate(results: readonly SarifResult[]): DebtEstimate {
  // Group by ruleId
  const byRule = new Map<string, { count: number; meta: RuleMeta }>();
  for (const r of results) {
    const meta = getMeta(r.ruleId);
    const existing = byRule.get(r.ruleId);
    if (existing) {
      existing.count++;
    } else {
      byRule.set(r.ruleId, { count: 1, meta });
    }
  }

  // Build per-rule rows
  const ruleRows: DebtRuleEstimate[] = [];
  const byCategoryMap = new Map<string, { debtMinutes: number; findingCount: number }>();

  for (const [ruleId, { count, meta }] of byRule) {
    const totalMinutes = count * meta.debtMinutes;
    ruleRows.push({
      ruleId,
      category: meta.category,
      findingCount: count,
      minutesPerInstance: meta.debtMinutes,
      totalMinutes,
    });

    const catEntry = byCategoryMap.get(meta.category) ?? { debtMinutes: 0, findingCount: 0 };
    catEntry.debtMinutes += totalMinutes;
    catEntry.findingCount += count;
    byCategoryMap.set(meta.category, catEntry);
  }

  // Sort by totalMinutes desc, take top 10
  ruleRows.sort((a, b) => b.totalMinutes - a.totalMinutes);
  const topRules = ruleRows.slice(0, 10);

  // Build category array
  const categoryRows: DebtCategoryEstimate[] = [];
  for (const [category, { debtMinutes, findingCount }] of byCategoryMap) {
    categoryRows.push({
      category,
      debtMinutes,
      debtHours: Math.round((debtMinutes / 60) * 10) / 10,
      findingCount,
    });
  }
  categoryRows.sort((a, b) => b.debtMinutes - a.debtMinutes);

  const totalDebtMinutes = ruleRows.reduce((s, r) => s + r.totalMinutes, 0);
  const totalDebtHours = Math.round((totalDebtMinutes / 60) * 10) / 10;

  return {
    totalDebtMinutes,
    totalDebtHours,
    byCategory: categoryRows,
    byRule: topRules,
  };
}

function computeAtdi(
  results: readonly SarifResult[],
  structural: StructuralHealth,
): AtdiScore {
  // Total modules across all repos (fallback to 1 to avoid division by zero)
  const totalModules = structural.repos.reduce((s, r) => s + r.moduleCount, 0) || 1;

  // Finding debt per category (0-70 cap)
  const byCategory = new Map<string, { errors: number; warnings: number; notes: number }>();
  for (const r of results) {
    const { category } = getMeta(r.ruleId);
    const existing = byCategory.get(category) ?? { errors: 0, warnings: 0, notes: 0 };
    if (r.level === "error") existing.errors++;
    else if (r.level === "warning") existing.warnings++;
    else existing.notes++;
    byCategory.set(category, existing);
  }

  const categoryBreakdown: AtdiCategoryBreakdown[] = [];
  let findingDebt = 0;

  for (const [category, counts] of byCategory) {
    const weight = CATEGORY_WEIGHTS[category] ?? 0;
    const weighted = (counts.errors * 3 + counts.warnings * 1 + counts.notes * 0.3) / totalModules;
    const contribution = weighted * weight;
    findingDebt += contribution;
    categoryBreakdown.push({
      category,
      contribution: Math.round(contribution * 100) / 100,
      findingDensity: Math.round(weighted * 1000) / 1000,
    });
  }
  findingDebt = Math.min(70, findingDebt);

  // Structural debt (0-30 cap)
  let structuralDebt = 0;
  if (structural.repos.length > 0) {
    const repoDebt = structural.repos.map((r) =>
      r.avgDistance * 15 + (r.painZonePct / 100) * 10 + (r.uselessnessPct / 100) * 5,
    );
    structuralDebt = repoDebt.reduce((s, v) => s + v, 0) / structural.repos.length;
    structuralDebt = Math.min(30, structuralDebt);
  }

  // Invert so higher = healthier (consistent with executive score and atdi.ts).
  const debtTotal = Math.min(100, Math.max(0, findingDebt + structuralDebt));
  const score = Math.round((100 - debtTotal) * 10) / 10;

  // Trend
  const totalFindingCount = results.length;
  const newFindingCount = results.filter((r) => r.baselineState === "new").length;
  const absentCount = results.filter((r) => r.baselineState === "absent").length;

  let trend: AtdiScore["trend"];
  if (newFindingCount > totalFindingCount * 0.2) {
    trend = "worsening";
  } else if (absentCount > 0) {
    trend = "improving";
  } else {
    trend = "stable";
  }

  return { score, trend, newFindingCount, totalFindingCount, categoryBreakdown };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function ratingIcon(rating: string): string {
  if (rating === "good") return "✅";
  if (rating === "warning") return "⚠️";
  return "🔴";
}

export function renderPracticesMarkdown(report: PracticesReport): string {
  const lines: string[] = [];
  const push = (...s: string[]) => lines.push(...s);

  push("# Best Practices Report", "");
  push(
    `Generated: ${report.generatedAt} | Repos: ${report.repoCount}`,
    "",
  );

  // --- Executive Summary ---
  push("## Executive Summary", "");
  push(`**Grade: ${report.executive.grade}** (${report.executive.score}/100)`, "");
  push(report.executive.headline, "");

  if (report.executive.topActions.length > 0) {
    push("### Top Actions");
    report.executive.topActions.forEach((a, i) => push(`${i + 1}. ${a}`));
    push("");
  }

  // --- Technical Debt Index ---
  push("## Technical Debt Index", "");
  push(`**ATDI: ${report.atdi.score}/100** (${report.atdi.trend})`, "");
  push(`New findings: ${report.atdi.newFindingCount} | Total: ${report.atdi.totalFindingCount}`, "");
  if (report.atdi.categoryBreakdown.length > 0) {
    push("| Category | Contribution | Density |");
    push("|----------|-------------|---------|");
    for (const row of report.atdi.categoryBreakdown) {
      push(`| ${row.category} | ${row.contribution} | ${row.findingDensity} |`);
    }
    push("");
  }

  // --- Estimated Remediation Cost ---
  push("## Estimated Remediation Cost", "");
  if (report.debt.totalDebtMinutes > 0) {
    const days = Math.round((report.debt.totalDebtHours / 6) * 10) / 10;
    push(`**Total: ${report.debt.totalDebtHours} hours** (${days} days at 6h/day)`, "");
    if (report.debt.byCategory.length > 0) {
      push("| Category | Hours | Findings | Avg/Finding |");
      push("|----------|-------|----------|-------------|");
      for (const cat of report.debt.byCategory) {
        const avgMin = (cat.debtMinutes / cat.findingCount).toFixed(0);
        push(`| ${cat.category} | ${cat.debtHours}h | ${cat.findingCount} | ${avgMin}m |`);
      }
      push("");
    }
    if (report.debt.byRule.length > 0) {
      push("Top contributors:");
      push("| Rule | Count | Per Instance | Total |");
      push("|------|-------|--------------|-------|");
      for (const r of report.debt.byRule) {
        const totalHours = (r.totalMinutes / 60).toFixed(1);
        push(`| \`${r.ruleId}\` | ${r.findingCount} | ${r.minutesPerInstance}m | ${r.totalMinutes}m (${totalHours}h) |`);
      }
      push("");
    }
  } else {
    push("No findings — zero estimated remediation cost.", "");
  }

  // --- Priority Findings ---
  push("## Priority Findings", "");

  const findingTable = (groups: readonly FindingGroup[]) => {
    push("| Rule | Category | Count | New? | Action |");
    push("|------|----------|-------|------|--------|");
    for (const g of groups) {
      const newMark = g.hasNew ? "yes" : "";
      const action = g.action.replace(/\|/g, "\\|");
      push(`| \`${g.ruleId}\` | ${g.category} | ${g.count} | ${newMark} | ${action} |`);
    }
    push("");
  };

  push("### 🔴 Fix Now");
  if (report.findings.fixNow.length > 0) {
    findingTable(report.findings.fixNow);
  } else {
    push("No critical findings.", "");
  }

  push("### 🟡 Plan For");
  if (report.findings.planFor.length > 0) {
    findingTable(report.findings.planFor);
  } else {
    push("No medium-priority findings.", "");
  }

  push("### 🟢 Monitor");
  if (report.findings.monitor.length > 0) {
    findingTable(report.findings.monitor);
  } else {
    push("No low-priority findings.", "");
  }

  // --- Structural Health ---
  push("## Structural Health", "");
  if (report.structural.repos.length > 0) {
    push(
      "| Repo | Modules | Dist. from Main Seq. | Pain Zone % | Uselessness % |",
    );
    push("|------|---------|---------------------|-------------|---------------|");
    for (const r of report.structural.repos) {
      const distCell = `${r.avgDistance} ${ratingIcon(r.distanceRating)}`;
      const painCell = `${r.painZonePct}% ${ratingIcon(r.painRating)}`;
      const uselessCell = `${r.uselessnessPct}% ${ratingIcon(r.uselessnessRating)}`;
      push(
        `| ${r.repo} | ${r.moduleCount} | ${distCell} | ${painCell} | ${uselessCell} |`,
      );
    }
    push("");
  } else {
    push("No structural metrics available.", "");
  }

  // --- Category Scorecard ---
  push("## Category Scorecard", "");
  if (report.scorecard.length > 0) {
    push("| Category | Health | Errors | Warnings | Notes | Total |");
    push("|----------|--------|--------|----------|-------|-------|");
    for (const row of report.scorecard) {
      push(
        `| ${row.category} | ${row.stars} | ${row.errorCount} | ${row.warningCount} | ${row.noteCount} | ${row.total} |`,
      );
    }
    push("");
  } else {
    push("No findings to score.", "");
  }

  // --- Recommendations ---
  push("## Recommendations", "");
  if (report.recommendations.length > 0) {
    for (const rec of report.recommendations) {
      push(`${rec.priority}. **${rec.title}** (Effort: ${rec.effort})`);
      push(`   ${rec.rationale}`);
      if (rec.guideRef) push(`   📖 ${rec.guideRef}`);
      push("");
    }
  } else {
    push("No specific recommendations at this time.", "");
  }

  push("---");
  push("*See docs/findings-guide.md for detailed rule documentation.*");

  return lines.join("\n");
}

export function renderPracticesTable(report: PracticesReport): string {
  const lines: string[] = [];
  const push = (...s: string[]) => lines.push(...s);

  push(
    `Practices Report — Grade: ${report.executive.grade} (${report.executive.score}/100) — ${report.repoCount} repo(s)`,
  );
  push(report.executive.headline);
  push(`ATDI: ${report.atdi.score}/100 (${report.atdi.trend})`);
  const debtDays = Math.round((report.debt.totalDebtHours / 6) * 10) / 10;
  push(`Estimated Debt: ${report.debt.totalDebtHours} hours (${debtDays} days at 6h/day)`);
  push("");

  // Scorecard table
  if (report.scorecard.length > 0) {
    push("Category Scorecard:");
    push(
      formatTable(
        ["Category", "Health", "Errors", "Warnings", "Notes", "Total"],
        report.scorecard.map((r) => [
          r.category,
          r.stars,
          String(r.errorCount),
          String(r.warningCount),
          String(r.noteCount),
          String(r.total),
        ]),
      ),
    );
    push("");
  }

  // Top 5 findings
  const allFindings = [
    ...report.findings.fixNow,
    ...report.findings.planFor,
    ...report.findings.monitor,
  ].slice(0, 5);

  if (allFindings.length > 0) {
    push("Top Findings:");
    push(
      formatTable(
        ["Rule", "Category", "Level", "Count", "Score"],
        allFindings.map((g) => [
          g.ruleId,
          g.category,
          g.level,
          String(g.count),
          String(g.priorityScore),
        ]),
      ),
    );
    push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function practicesCommand(
  options: PracticesOptions,
): Promise<PracticesReport> {
  const { kvStore, format, output, topN } = options;

  // Read sarif:latest
  const sarifJson = await kvStore.get("sarif:latest");
  let results: SarifResult[] = [];
  if (sarifJson) {
    try {
      const log = JSON.parse(sarifJson) as SarifLog;
      results = [...(log.runs[0]?.results ?? [])];
    } catch {
      // Malformed sarif:latest — skip rather than aborting the entire command.
    }
  }

  // Discover repos
  const repos = await discoverRepos(kvStore);

  // Build sections
  const structural = await assessStructuralHealth(kvStore, repos);
  const findings = prioritizeFindings(results);
  const scorecard = buildScorecard(results);

  // Executive summary needs findings to determine top actions
  const rawExec = buildExecutiveSummary(results, structural);
  const topActionSource =
    findings.fixNow.length > 0 ? findings.fixNow : findings.planFor;
  const topActions = topActionSource.slice(0, 3).map((g) => g.action);
  const executive: ExecutiveSummary = { ...rawExec, topActions };

  const recommendations = synthesizeRecommendations(findings, structural);
  const atdi = computeAtdi(results, structural);
  const debt = computeDebtEstimate(results);

  // Apply topN to fixNow tier if requested
  const cappedFindings: PrioritizedFindings =
    topN !== undefined
      ? {
          fixNow: findings.fixNow.slice(0, topN),
          planFor: findings.planFor.slice(0, topN),
          monitor: findings.monitor.slice(0, topN),
        }
      : findings;

  const report: PracticesReport = {
    schemaVersion: "1.2",
    generatedAt: new Date().toISOString(),
    repoCount: repos.length,
    executive,
    findings: cappedFindings,
    structural,
    scorecard,
    recommendations,
    atdi,
    debt,
  };

  // Render
  let rendered: string;
  if (format === "json") {
    rendered = JSON.stringify(report, null, 2);
  } else if (format === "table") {
    rendered = renderPracticesTable(report);
  } else {
    // markdown (default), "both", "sarif" → use markdown
    rendered = renderPracticesMarkdown(report);
  }

  if (output) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(output, rendered + "\n", "utf-8");
    console.error(`Wrote practices report to ${output}`);
  } else if (!options.silent) {
    console.log(rendered);
  }

  return report;
}
