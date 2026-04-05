/**
 * Scoring and metrics builders for the `mma practices` command.
 *
 * Covers: executive summary, finding prioritization, structural health
 * assessment, category scorecard, recommendations, debt estimation, and ATDI.
 */

import type { SarifResult } from "@mma/core";
import type { KVStore } from "@mma/storage";
import type { RepoMetricsSummary } from "@mma/core";
import { getMeta, CATEGORY_WEIGHTS } from "./rule-metadata.js";
import type {
  ExecutiveSummary,
  PrioritizedFindings,
  FindingGroup,
  StructuralHealth,
  RepoHealthEntry,
  CategoryScorecard,
  CategoryRow,
  Recommendation,
  DebtEstimate,
  DebtRuleEstimate,
  DebtCategoryEstimate,
  AtdiScore,
  AtdiCategoryBreakdown,
} from "./types.js";

// ---------------------------------------------------------------------------
// Grade helpers
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

// ---------------------------------------------------------------------------
// Executive summary
// ---------------------------------------------------------------------------

export function buildExecutiveSummary(
  atdiScore: number,
): ExecutiveSummary {
  const score = Math.round(Math.max(0, Math.min(100, atdiScore)));
  const grade = scoreToGrade(score);
  const headline = gradeHeadline(grade, score);

  return { grade, score, headline, topActions: [] };
}

// ---------------------------------------------------------------------------
// Finding prioritization
// ---------------------------------------------------------------------------

function levelSeverityWeight(level: string): number {
  if (level === "error") return 100;
  if (level === "warning") return 60;
  return 20;
}

export function prioritizeFindings(results: readonly SarifResult[]): PrioritizedFindings {
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

// ---------------------------------------------------------------------------
// Structural health
// ---------------------------------------------------------------------------

export async function assessStructuralHealth(
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

// ---------------------------------------------------------------------------
// Category scorecard
// ---------------------------------------------------------------------------

export function buildScorecard(results: readonly SarifResult[]): CategoryScorecard {
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

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export function synthesizeRecommendations(
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

// ---------------------------------------------------------------------------
// Debt estimation
// ---------------------------------------------------------------------------

export function computeDebtEstimate(results: readonly SarifResult[]): DebtEstimate {
  // Group by ruleId
  const byRule = new Map<string, { count: number; meta: ReturnType<typeof getMeta> }>();
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

// ---------------------------------------------------------------------------
// ATDI
// ---------------------------------------------------------------------------

export function computeAtdi(
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
