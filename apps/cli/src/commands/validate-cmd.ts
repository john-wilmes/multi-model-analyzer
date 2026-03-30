/**
 * `mma validate` — Statistical validation of SARIF findings.
 *
 * Samples findings from the DB, independently verifies each against raw graph
 * edges and (optionally) source code, and reports precision/recall per rule.
 *
 * The same check functions are shared with the vitest validation suite in
 * validation/models/sarif-findings.validation.test.ts.
 *
 * Submodules:
 *   validation/sampling.ts
 *   validation/sarif-helpers.ts
 *   validation/instability.ts
 *   validation/barrel-detection.ts
 *   validation/reporter.ts
 *   validation/precision-recall-checks.ts
 *   validation/sanity-checks.ts
 *   validation/formatters.ts
 */

export { mulberry32, sampleN } from "./validation/sampling.js";
export type { SarifFinding } from "./validation/sarif-helpers.js";
export { getAllFindings, flattenFindings, fqn } from "./validation/sarif-helpers.js";
export type { ModuleInstability } from "./validation/instability.js";
export {
  computeInstabilityFromEdges,
  resetCaches,
  getImportEdges,
  getInstability,
} from "./validation/instability.js";
export type { AssertionResult, ValidateOptions, ValidateResult } from "./validation/reporter.js";
export { ValidationReporter } from "./validation/reporter.js";
export {
  checkDeadExport,
  checkUnstableDependency,
  checkPainZone,
  checkUselessnessZone,
  checkFault,
  checkBlastRadius,
  checkThresholdConsistency,
} from "./validation/precision-recall-checks.js";
export {
  checkSanityEdges,
  checkSanitySarif,
  checkSanityT1Coverage,
  checkSanityDrain,
  checkSanityAtdi,
  checkSanityCatalog,
  checkSanityFeatureFlags,
  checkSanityPainZoneFilter,
  checkSanityInstability,
  checkSanityPatternRecall,
  checkSanityFeatureFlagSource,
  checkSanityCallGraphSource,
  checkSanityDashboard,
  checkSanityConfigValidation,
} from "./validation/sanity-checks.js";
export type { SarifDocument } from "./validation/sanity-checks.js";

import { writeFile } from "node:fs/promises";
import { mulberry32 } from "./validation/sampling.js";
import { ValidationReporter } from "./validation/reporter.js";
import type { ValidateOptions, ValidateResult } from "./validation/reporter.js";
import { resetCaches } from "./validation/instability.js";
import {
  checkDeadExport,
  checkUnstableDependency,
  checkPainZone,
  checkUselessnessZone,
  checkFault,
  checkBlastRadius,
  checkThresholdConsistency,
} from "./validation/precision-recall-checks.js";
import {
  checkSanityEdges,
  checkSanitySarif,
  checkSanityT1Coverage,
  checkSanityDrain,
  checkSanityAtdi,
  checkSanityCatalog,
  checkSanityFeatureFlags,
  checkSanityPainZoneFilter,
  checkSanityInstability,
  checkSanityPatternRecall,
  checkSanityFeatureFlagSource,
  checkSanityCallGraphSource,
  checkSanityDashboard,
  checkSanityConfigValidation,
} from "./validation/sanity-checks.js";
import { formatTable, formatMarkdown } from "./validation/formatters.js";

export async function validateCommand(opts: ValidateOptions): Promise<ValidateResult> {
  const sampleSize = opts.sampleSize ?? 50;
  const seed = opts.seed ?? 42;
  const format = opts.format ?? "table";
  const rng = mulberry32(seed);
  const reporter = new ValidationReporter();

  // Reset per-run caches
  resetCaches();

  // Run all checks
  await checkDeadExport(opts.kvStore, opts.graphStore, reporter, sampleSize, rng);
  await checkUnstableDependency(opts.kvStore, opts.graphStore, reporter, sampleSize, rng);
  await checkPainZone(opts.kvStore, opts.graphStore, reporter, sampleSize, rng);
  await checkUselessnessZone(opts.kvStore, opts.graphStore, reporter, sampleSize, rng);
  await checkFault(opts.kvStore, opts.graphStore, reporter, sampleSize, rng, opts.mirrorsDir);
  await checkBlastRadius(opts.kvStore, opts.graphStore, reporter, sampleSize, rng);
  await checkThresholdConsistency(opts.kvStore, reporter);

  // Sanity checks (corpus-agnostic structural integrity)
  await checkSanityEdges(opts.kvStore, opts.graphStore, reporter);
  await checkSanitySarif(opts.kvStore, opts.graphStore, reporter);
  await checkSanityT1Coverage(opts.kvStore, opts.graphStore, reporter);
  await checkSanityDrain(opts.kvStore, opts.graphStore, reporter);
  await checkSanityAtdi(opts.kvStore, opts.graphStore, reporter);
  await checkSanityCatalog(opts.kvStore, opts.graphStore, reporter);
  await checkSanityFeatureFlags(opts.kvStore, opts.graphStore, reporter);
  await checkSanityPainZoneFilter(opts.kvStore, opts.graphStore, reporter);
  await checkSanityInstability(opts.kvStore, opts.graphStore, reporter);
  await checkSanityConfigValidation(opts.kvStore, opts.graphStore, reporter);

  // Source-level sanity checks (require mirrorsDir)
  await checkSanityPatternRecall(opts.kvStore, opts.graphStore, reporter, sampleSize, rng, opts.mirrorsDir);
  await checkSanityFeatureFlagSource(opts.kvStore, opts.graphStore, reporter, sampleSize, rng, opts.mirrorsDir);
  await checkSanityCallGraphSource(opts.kvStore, opts.graphStore, reporter, sampleSize, rng, opts.mirrorsDir);
  await checkSanityDashboard(opts.kvStore, opts.graphStore, reporter);

  const result = reporter.toJSON();

  // Format and output
  let output: string;
  switch (format) {
    case "json":
      output = JSON.stringify(result, null, 2);
      break;
    case "markdown":
      output = formatMarkdown(result);
      break;
    default:
      output = formatTable(result);
      break;
  }

  if (opts.output) {
    await writeFile(opts.output, output + "\n", "utf-8");
  } else {
    console.log(output);
  }

  return result;
}
