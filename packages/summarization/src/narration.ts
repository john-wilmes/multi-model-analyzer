/**
 * Phase 8: LLM narration layer.
 *
 * Turns pre-computed static analysis results into developer-friendly prose.
 * Uses the existing Anthropic API infrastructure (retry, rate-limit handling).
 * Gated behind `anthropicApiKey` — never runs without an explicit key.
 *
 * Key constraint: narrate pre-computed results only — never make analytical
 * claims beyond what the data shows.
 */

import type { KVStore } from "@mma/storage";
import { callAnthropicWithRetry, SONNET_DEFAULTS } from "./sonnet.js";
import type { SonnetOptions } from "./sonnet.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NarrationType =
  | "repo-architecture"
  | "health-summary"
  | "service-catalog"
  | "system-overview";

export interface RepoNarrationInput {
  readonly repo: string;
  /** Detected design patterns (e.g. "factory", "observer"). */
  readonly patterns: readonly string[];
  /** Metric summary: moduleCount, avgInstability, painZoneCount, etc. */
  readonly metricsSummary: {
    readonly moduleCount: number;
    readonly avgInstability: number;
    readonly avgAbstractness: number;
    readonly avgDistance: number;
    readonly painZoneCount: number;
    readonly uselessnessZoneCount: number;
  } | null;
  /** SARIF finding counts by category (e.g. { arch: 3, fault: 1 }). */
  readonly sarifCounts: Record<string, number>;
  /** Service names discovered in the repo. */
  readonly services: readonly string[];
  /** Tier-4 service summaries (from summarization). */
  readonly serviceSummaries: readonly string[];
  /** Cross-repo edge count involving this repo. */
  readonly crossRepoEdges: number;
}

export interface SystemNarrationInput {
  readonly repoNames: readonly string[];
  readonly totalFindings: number;
  readonly crossRepoEdgeCount: number;
  readonly linchpins: readonly string[];
}

export interface NarrationResult {
  readonly type: NarrationType;
  readonly key: string;
  readonly text: string;
  readonly cached: boolean;
}

export interface NarrationOptions {
  readonly apiKey: string;
  readonly kvStore: KVStore;
  readonly model?: string;
  readonly maxTokens?: number;
  /** When true, bypass the narration cache and regenerate all narrations. */
  readonly force?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NARRATION_CACHE_PREFIX = "narration:";

const NARRATION_KEYS: Record<NarrationType, (repo?: string) => string> = {
  "repo-architecture": (repo) => `${NARRATION_CACHE_PREFIX}repo-arch:${repo}`,
  "health-summary": (repo) => `${NARRATION_CACHE_PREFIX}health:${repo}`,
  "service-catalog": (repo) => `${NARRATION_CACHE_PREFIX}catalog:${repo}`,
  "system-overview": () => `${NARRATION_CACHE_PREFIX}system`,
};

const MAX_TOKENS: Record<NarrationType, number> = {
  "repo-architecture": 600,
  "health-summary": 600,
  "service-catalog": 600,
  "system-overview": 800,
};

// ---------------------------------------------------------------------------
// Prompt Builders
// ---------------------------------------------------------------------------

const PREAMBLE =
  "Summarize the following pre-computed static analysis results. " +
  "Do not make claims beyond what the data shows.";

export function buildRepoArchPrompt(input: RepoNarrationInput): string {
  const lines = [PREAMBLE, "", `Repository: ${input.repo}`];
  if (input.patterns.length > 0) {
    lines.push(`Detected patterns: ${input.patterns.join(", ")}`);
  }
  if (input.metricsSummary) {
    const m = input.metricsSummary;
    lines.push(`Modules: ${m.moduleCount}`);
    lines.push(`Avg instability: ${m.avgInstability.toFixed(2)}, avg abstractness: ${m.avgAbstractness.toFixed(2)}`);
    lines.push(`Distance from main sequence: ${m.avgDistance.toFixed(2)}`);
  }
  if (input.crossRepoEdges > 0) {
    lines.push(`Cross-repo edges: ${input.crossRepoEdges}`);
  }
  lines.push("", "Write 3-4 sentences of plain prose describing the architecture.");
  return lines.join("\n");
}

export function buildHealthPrompt(input: RepoNarrationInput): string {
  const lines = [PREAMBLE, "", `Repository: ${input.repo}`];
  const cats = Object.entries(input.sarifCounts);
  if (cats.length > 0) {
    lines.push("SARIF findings by category:");
    for (const [cat, count] of cats) {
      lines.push(`  - ${cat}: ${count}`);
    }
  } else {
    lines.push("No SARIF findings detected.");
  }
  if (input.metricsSummary) {
    const m = input.metricsSummary;
    if (m.painZoneCount > 0) lines.push(`Pain zone modules: ${m.painZoneCount}`);
    if (m.uselessnessZoneCount > 0) lines.push(`Uselessness zone modules: ${m.uselessnessZoneCount}`);
  }
  lines.push("", "Write 3-4 sentences of plain prose summarizing the health of this repository.");
  return lines.join("\n");
}

export function buildCatalogPrompt(input: RepoNarrationInput): string {
  const lines = [PREAMBLE, "", `Repository: ${input.repo}`];
  if (input.services.length > 0) {
    lines.push("Services:");
    for (const svc of input.services) lines.push(`  - ${svc}`);
  } else {
    lines.push("No services detected.");
  }
  if (input.serviceSummaries.length > 0) {
    lines.push("Service summaries:");
    for (const s of input.serviceSummaries) lines.push(`  - ${s}`);
  }
  lines.push("", "Write 3-4 sentences of plain prose describing the service catalog.");
  return lines.join("\n");
}

export function buildSystemPrompt(input: SystemNarrationInput): string {
  const lines = [PREAMBLE, ""];
  lines.push(`Repositories: ${input.repoNames.join(", ")}`);
  lines.push(`Total SARIF findings: ${input.totalFindings}`);
  lines.push(`Cross-repo edges: ${input.crossRepoEdgeCount}`);
  if (input.linchpins.length > 0) {
    lines.push(`Linchpin modules: ${input.linchpins.join(", ")}`);
  }
  lines.push("", "Write 3-4 sentences of plain prose giving a system-wide overview.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core narration
// ---------------------------------------------------------------------------

export async function narrateSingle(
  type: NarrationType,
  prompt: string,
  key: string,
  options: NarrationOptions,
): Promise<NarrationResult> {
  // Check cache (skipped when force=true)
  if (!options.force) {
    const cached = await options.kvStore.get(key);
    if (cached) {
      return { type, key, text: cached, cached: true };
    }
  }

  const sonnetOpts: SonnetOptions = {
    apiKey: options.apiKey,
    model: options.model ?? SONNET_DEFAULTS.model,
    maxTokens: options.maxTokens ?? MAX_TOKENS[type],
    batchSize: 1,
  };

  const text = await callAnthropicWithRetry(prompt, sonnetOpts);
  const trimmed = text.trim();

  // Write to cache
  await options.kvStore.set(key, trimmed);

  return { type, key, text: trimmed, cached: false };
}

/**
 * Narrate all repos + optional system overview.
 * Returns one result per narration produced.
 */
export async function narrateAll(
  repoInputs: readonly RepoNarrationInput[],
  systemInput: SystemNarrationInput | undefined,
  options: NarrationOptions,
): Promise<NarrationResult[]> {
  const results: NarrationResult[] = [];

  for (const input of repoInputs) {
    const types: Array<{
      type: NarrationType;
      prompt: string;
      key: string;
    }> = [
      {
        type: "repo-architecture",
        prompt: buildRepoArchPrompt(input),
        key: NARRATION_KEYS["repo-architecture"](input.repo),
      },
      {
        type: "health-summary",
        prompt: buildHealthPrompt(input),
        key: NARRATION_KEYS["health-summary"](input.repo),
      },
      {
        type: "service-catalog",
        prompt: buildCatalogPrompt(input),
        key: NARRATION_KEYS["service-catalog"](input.repo),
      },
    ];

    for (const { type, prompt, key } of types) {
      try {
        const result = await narrateSingle(type, prompt, key, options);
        results.push(result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[narration] Failed ${type} for ${input.repo}: ${msg}`);
      }
    }
  }

  // System overview
  if (systemInput) {
    const key = NARRATION_KEYS["system-overview"]();
    const prompt = buildSystemPrompt(systemInput);
    try {
      const result = await narrateSingle("system-overview", prompt, key, options);
      results.push(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[narration] Failed system-overview: ${msg}`);
    }
  }

  return results;
}
