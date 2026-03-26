/**
 * Barrel export for the practices command modules.
 *
 * Source modules (TypeScript):
 *   - types.ts         — public interfaces and option types
 *   - rule-metadata.ts — rule registry, category weights, getMeta helper
 *   - scoring.ts       — executive summary, finding prioritization, structural health,
 *                        scorecard, recommendations, debt estimation, ATDI
 *   - renderers.ts     — markdown and terminal table renderers
 */

export type {
  PracticesOptions,
  PracticesReport,
  DebtEstimate,
  DebtCategoryEstimate,
  DebtRuleEstimate,
  ExecutiveSummary,
  PrioritizedFindings,
  FindingGroup,
  StructuralHealth,
  RepoHealthEntry,
  CategoryScorecard,
  CategoryRow,
  Recommendation,
  AtdiScore,
  AtdiCategoryBreakdown,
} from "./types.js";

export {
  CATEGORY_WEIGHTS,
  RULE_METADATA,
  getMeta,
  inferCategoryFromRuleId,
} from "./rule-metadata.js";

export {
  buildExecutiveSummary,
  prioritizeFindings,
  assessStructuralHealth,
  buildScorecard,
  synthesizeRecommendations,
  computeDebtEstimate,
  computeAtdi,
} from "./scoring.js";

export {
  renderPracticesMarkdown,
  renderPracticesTable,
} from "./renderers.js";
