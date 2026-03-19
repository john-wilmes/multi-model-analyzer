/**
 * Tier 3 summarization: Claude Haiku via Anthropic API.
 *
 * Low-cost LLM pass for entities that tier-1/tier-2 could not describe
 * with sufficient confidence. Each entity's existing description is
 * refined into a more specific, business-logic-focused summary.
 *
 * Example: "Queries the appointment table filtering by patient ID and
 *           date range, maps results to Appointment DTOs, handles pagination"
 */

import type { Summary } from "@mma/core";
import type { KVStore } from "@mma/storage";
import { callAnthropicWithRetry } from "./sonnet.js";

const T3_CACHE_PREFIX = "summary:t3:";

export interface HaikuOptions {
  readonly model?: string;
  readonly maxTokens?: number;
  readonly concurrency?: number;
  readonly kvStore?: KVStore;
}

const DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 200;
const DEFAULT_CONCURRENCY = 20;

export async function summarizeWithHaiku(
  entityId: string,
  description: string,
  context: string,
  apiKey: string,
  options: HaikuOptions = {},
): Promise<Summary> {
  // Check KV cache before hitting the API
  if (options.kvStore) {
    const cached = await options.kvStore.get(T3_CACHE_PREFIX + entityId);
    if (cached) {
      return JSON.parse(cached) as Summary;
    }
  }

  const model = options.model ?? DEFAULT_HAIKU_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  const prompt = buildPrompt(entityId, description, context);

  try {
    const text = await callAnthropicWithRetry(prompt, {
      apiKey,
      model,
      maxTokens,
      batchSize: 1,
    });
    const trimmed = text.trim();
    if (!trimmed) {
      return {
        entityId,
        tier: 3,
        description,
        confidence: 0,
      };
    }
    const result: Summary = {
      entityId,
      tier: 3,
      description: trimmed,
      confidence: 0.85,
    };
    // Write to cache on success
    if (options.kvStore && result.confidence > 0) {
      await options.kvStore.set(T3_CACHE_PREFIX + entityId, JSON.stringify(result));
    }
    return result;
  } catch {
    return {
      entityId,
      tier: 3,
      description,
      confidence: 0,
    };
  }
}

function buildPrompt(
  entityId: string,
  description: string,
  context: string,
): string {
  const hasSource = context && context !== entityId && context.length > 20;
  const lines: string[] = [
    "Improve this summary of a code entity in 1-2 sentences.",
    "Focus on the business logic, not the implementation details.",
    "Be specific about what data is processed and what the output is.",
  ];
  if (hasSource) {
    lines.push("Use the source code below to produce an accurate summary.");
  }
  lines.push("", `Entity: ${entityId}`);
  if (hasSource) {
    lines.push("", "Source code:", "```", context, "```");
  }
  lines.push("", `Current description: ${description}`, "", "Improved summary:");
  return lines.join("\n");
}

export async function tier3BatchSummarize(
  entities: readonly { entityId: string; description: string; context: string }[],
  apiKey: string,
  options: HaikuOptions = {},
): Promise<Summary[]> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const step = Math.max(1, Math.floor(concurrency));
  const results: Summary[] = [];
  for (let i = 0; i < entities.length; i += step) {
    const batch = entities.slice(i, i + step);
    const batchResults = await Promise.all(
      batch.map((e) =>
        summarizeWithHaiku(e.entityId, e.description, e.context, apiKey, options),
      ),
    );
    results.push(...batchResults);
  }
  return results;
}
