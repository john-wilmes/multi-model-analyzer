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

export interface SonnetOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly batchSize: number;
}

export const SONNET_DEFAULTS: Omit<SonnetOptions, "apiKey"> = {
  model: "claude-sonnet-4-6-20250514",
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

export async function summarizeWithSonnet(
  input: ServiceSummaryInput,
  options: SonnetOptions,
): Promise<Summary> {
  const prompt = buildServicePrompt(input);

  try {
    const response = await callSonnet(prompt, options);
    return {
      entityId: input.entityId,
      tier: 4,
      description: response.trim(),
      confidence: 0.95,
    };
  } catch {
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
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const textBlock = data.content.find((c) => c.type === "text");
  return textBlock?.text ?? "";
}

export async function tier4BatchSummarize(
  inputs: readonly ServiceSummaryInput[],
  options: SonnetOptions,
): Promise<Summary[]> {
  const results: Summary[] = [];
  if (options.batchSize <= 0) {
    throw new Error(`batchSize must be positive, got ${options.batchSize}`);
  }

  // Process in batches to respect rate limits
  for (let i = 0; i < inputs.length; i += options.batchSize) {
    const batch = inputs.slice(i, i + options.batchSize);
    const batchResults = await Promise.all(
      batch.map((input) => summarizeWithSonnet(input, options)),
    );
    results.push(...batchResults);
  }

  return results;
}
