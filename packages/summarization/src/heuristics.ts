/**
 * Tier 2 summarization: heuristic descriptions from naming analysis.
 *
 * Free, instant, always runs. Produces method purpose descriptions.
 * Example: "Fetches appointments for a patient on a given date"
 */

import type { MethodPurpose, Summary } from "@mma/core";

/** @internal */
export function summarizeFromNaming(
  purpose: MethodPurpose,
): Summary {
  return {
    entityId: purpose.methodId,
    tier: 2,
    description: purpose.purpose,
    confidence: purpose.confidence,
  };
}

export function tier2Summarize(
  purposes: readonly MethodPurpose[],
): Summary[] {
  return purposes.map(summarizeFromNaming);
}

export function shouldEscalateToTier3(
  tier1: Summary | undefined,
  tier2: Summary | undefined,
  confidenceThreshold: number = 0.7,
): boolean {
  const best = tier2 ?? tier1;
  if (!best) return true;
  return best.confidence < confidenceThreshold;
}
