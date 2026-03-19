/**
 * Tier 4 summarization: Claude Sonnet for service-level descriptions.
 *
 * Costs API tokens, batched for efficiency.
 * Used sparingly: only for service-level summaries where tiers 1-3 are insufficient.
 *
 * Example: "The Scheduler service manages appointment booking, rescheduling,
 *           and cancellation across multiple provider calendars"
 */

import type { Summary } from "@mma/core";
import type { KVStore } from "@mma/storage";

export interface SonnetOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly batchSize: number;
}

export const SONNET_DEFAULTS: Omit<SonnetOptions, "apiKey"> = {
  model: "claude-sonnet-4-20250514",
  maxTokens: 500,
  batchSize: 5,
};

export interface ServiceSummaryInput {
  readonly entityId: string;
  readonly serviceName: string;
  readonly methodSummaries: readonly string[];
  readonly dependencies: readonly string[];
  readonly entryPoints: readonly string[];
}

export interface Tier4BatchOptions extends SonnetOptions {
  /** KV store for caching tier-4 summaries. */
  readonly kvStore?: KVStore;
  /** Maximum total API calls allowed; uncached services beyond this cap are skipped. */
  readonly maxApiCalls?: number;
}

/** How many API calls were made (for logging/testing). */
export interface Tier4BatchResult {
  readonly summaries: Summary[];
  readonly apiCallsMade: number;
  readonly cacheHits: number;
}

const T4_CACHE_PREFIX = "summary:t4:";

export async function summarizeWithSonnet(
  input: ServiceSummaryInput,
  options: SonnetOptions,
): Promise<Summary> {
  const prompt = buildServicePrompt(input);

  try {
    const response = await callSonnetWithRetry(prompt, options);
    return {
      entityId: input.entityId,
      tier: 4,
      description: response.trim(),
      confidence: 0.95,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[tier4] Sonnet failed for ${input.serviceName} (${input.entityId}): ${msg}`);
    return {
      entityId: input.entityId,
      tier: 4,
      description: `[Sonnet unavailable] Could not generate service summary for ${input.serviceName}`,
      confidence: 0,
    };
  }
}

function buildServicePrompt(input: ServiceSummaryInput): string {
  return [
    "Summarize this microservice in 2-3 sentences.",
    "Focus on its business purpose, key capabilities, and role in the system.",
    "",
    `Service: ${input.serviceName}`,
    `Entry points: ${input.entryPoints.join(", ") || "none detected"}`,
    `Dependencies: ${input.dependencies.join(", ") || "none"}`,
    "",
    "Key methods:",
    ...input.methodSummaries.map((s) => `  - ${s}`),
    "",
    "Service summary:",
  ].join("\n");
}

const RETRY_DELAYS = [1000, 2000, 4000, 8000];

/** Public wrapper around the retry-enabled Anthropic API caller. */
export async function callAnthropicWithRetry(
  prompt: string,
  options: SonnetOptions,
): Promise<string> {
  return callSonnetWithRetry(prompt, options);
}

async function callSonnetWithRetry(
  prompt: string,
  options: SonnetOptions,
): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await callSonnet(prompt, options);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // Only retry on 429 (rate limit)
      if (!err.message.includes("429")) {
        throw err;
      }

      lastError = err;
      if (attempt < RETRY_DELAYS.length) {
        // Honor Retry-After header if embedded in message, otherwise use backoff
        const retryAfterMatch = err.message.match(/retry-after:(\d+)/i);
        const delayMs = retryAfterMatch
          ? parseInt(retryAfterMatch[1]!, 10) * 1000
          : RETRY_DELAYS[attempt]!;
        await sleep(delayMs);
      }
    }
  }

  throw lastError ?? new Error("callSonnet failed after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callSonnet(
  prompt: string,
  options: SonnetOptions,
): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const extra = retryAfter ? ` retry-after:${retryAfter}` : "";
    throw new Error(`Anthropic API error: ${response.status}${extra}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const textBlock = data.content.find((c) => c.type === "text");
  return textBlock?.text ?? "";
}

export async function tier4BatchSummarize(
  inputs: readonly ServiceSummaryInput[],
  options: Tier4BatchOptions,
): Promise<Tier4BatchResult> {
  if (options.batchSize <= 0) {
    throw new Error(`batchSize must be positive, got ${options.batchSize}`);
  }

  const summaries: Summary[] = [];
  let apiCallsMade = 0;
  let cacheHits = 0;

  for (let i = 0; i < inputs.length; i += options.batchSize) {
    const batch = inputs.slice(i, i + options.batchSize);
    const batchResults = await Promise.all(
      batch.map(async (input) => {
        // Check cache first
        if (options.kvStore) {
          const cached = await options.kvStore.get(`${T4_CACHE_PREFIX}${input.entityId}`);
          if (cached) {
            cacheHits++;
            return JSON.parse(cached) as Summary;
          }
        }

        // Check API call cap
        if (options.maxApiCalls !== undefined && apiCallsMade >= options.maxApiCalls) {
          return {
            entityId: input.entityId,
            tier: 4,
            description: `[Skipped] API call cap reached (${options.maxApiCalls})`,
            confidence: 0,
          } satisfies Summary;
        }

        apiCallsMade++;
        const result = await summarizeWithSonnet(input, options);

        // Write to cache on success
        if (options.kvStore && result.confidence > 0) {
          await options.kvStore.set(`${T4_CACHE_PREFIX}${input.entityId}`, JSON.stringify(result));
        }

        return result;
      }),
    );
    summaries.push(...batchResults);
  }

  return { summaries, apiCallsMade, cacheHits };
}
