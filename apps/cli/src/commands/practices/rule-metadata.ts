/**
 * Rule metadata: category weights, per-rule metadata, and lookup helpers.
 */

export interface RuleMeta {
  readonly category: string;
  readonly interpretation: string;
  readonly action: string;
  readonly guideRef: string;
  readonly effort: "low" | "medium" | "high";
  readonly categoryWeight: number;
  readonly debtMinutes: number;
}

export const CATEGORY_WEIGHTS: Record<string, number> = {
  vulnerability: 30,
  fault: 20,
  architecture: 10,
  structural: 5,
  config: 5,
  "blast-radius": 0,
  temporal: 8,
  hotspot: 15,
};

export const RULE_METADATA: Record<string, RuleMeta> = {
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
    interpretation: "Two configuration parameters interact but no test covers their combined state.",
    action: "Add a test covering the parameter combination, or document that the interaction is intentionally unsupported.",
    guideRef: "`config/untested-interaction` in findings-guide.md",
    effort: "medium",
    categoryWeight: CATEGORY_WEIGHTS["config"]!,
    debtMinutes: 90,
  },
  "config/high-interaction-strength": {
    category: "config",
    interpretation: "Parameter participates in 3+ way interactions, indicating complex interdependencies.",
    action: "Review the parameter's interactions and generate a covering array with strength >= 3 for thorough testing.",
    guideRef: "`config/high-interaction-strength` in findings-guide.md",
    effort: "high",
    categoryWeight: CATEGORY_WEIGHTS["config"]!,
    debtMinutes: 120,
  },
  "config/dead-setting": {
    category: "config",
    interpretation: "Setting can never be used given current constraints — dead configuration.",
    action: "Remove the setting and any code paths that reference it.",
    guideRef: "`config/dead-setting` in findings-guide.md",
    effort: "low",
    categoryWeight: CATEGORY_WEIGHTS["config"]!,
    debtMinutes: 30,
  },
  "config/missing-dependency": {
    category: "config",
    interpretation: "A setting requires another parameter that is not configured or defined.",
    action: "Add the missing parameter to the configuration, or remove the dependent setting.",
    guideRef: "`config/missing-dependency` in findings-guide.md",
    effort: "medium",
    categoryWeight: CATEGORY_WEIGHTS["config"]!,
    debtMinutes: 60,
  },
  "config/conflicting-settings": {
    category: "config",
    interpretation: "Two settings contradict each other based on inferred constraints.",
    action: "Resolve the contradiction by removing one setting or adjusting constraints.",
    guideRef: "`config/conflicting-settings` in findings-guide.md",
    effort: "medium",
    categoryWeight: CATEGORY_WEIGHTS["config"]!,
    debtMinutes: 60,
  },
  "config/unused-registry-flag": {
    category: "config",
    interpretation: "Flag is defined in the registry enum but not referenced anywhere in code.",
    action: "Remove the flag from the registry if it is no longer needed, or add code that references it.",
    guideRef: "`config/unused-registry-flag` in findings-guide.md",
    effort: "low",
    categoryWeight: CATEGORY_WEIGHTS["config"]!,
    debtMinutes: 15,
  },
  "config/unregistered-flag": {
    category: "config",
    interpretation: "Flag is used in code but missing from the canonical registry enum.",
    action: "Add the flag to the registry enum to ensure it is tracked and governed.",
    guideRef: "`config/unregistered-flag` in findings-guide.md",
    effort: "low",
    categoryWeight: CATEGORY_WEIGHTS["config"]!,
    debtMinutes: 15,
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

export function inferCategoryFromRuleId(ruleId: string): string {
  if (ruleId.startsWith("vuln/")) return "vulnerability";
  if (ruleId.startsWith("fault/")) return "fault";
  if (ruleId.startsWith("arch/")) return "architecture";
  if (ruleId.startsWith("structural/")) return "structural";
  if (ruleId.startsWith("config/")) return "config";
  if (ruleId.startsWith("temporal-coupling/")) return "temporal";
  if (ruleId.startsWith("blast-radius/")) return "blast-radius";
  return "unknown";
}

export function getMeta(ruleId: string): RuleMeta {
  const known = RULE_METADATA[ruleId];
  if (known) return known;
  const category = inferCategoryFromRuleId(ruleId);
  const categoryWeight = CATEGORY_WEIGHTS[category] ?? 0;
  return { ...DEFAULT_META, category, categoryWeight };
}
