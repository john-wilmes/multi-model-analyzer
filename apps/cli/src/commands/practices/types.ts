/**
 * Public types for the `mma practices` command.
 */

import type { KVStore } from "@mma/storage";
import type { ReportFormat } from "../../formatter.js";

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
