/**
 * Tier 3 summarization: local LLM via Ollama (qwen2.5-coder:1.5b).
 *
 * Free (runs locally), moderate latency (~1-5s per method).
 * Produces method body summaries focused on business logic.
 *
 * Example: "Queries the appointment table filtering by patient ID and date range,
 *           maps results to Appointment objects, handles pagination"
 */

import type { Summary } from "@mma/core";

export interface OllamaOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeout: number;
}

const DEFAULT_OPTIONS: OllamaOptions = {
  baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  model: process.env.OLLAMA_MODEL ?? "qwen2.5-coder:1.5b",
  timeout: 30_000,
};

/** @internal */
export async function summarizeWithOllama(
  entityId: string,
  sourceCode: string,
  context: string,
  options: Partial<OllamaOptions> = {},
): Promise<Summary> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const prompt = buildPrompt(sourceCode, context);

  try {
    const response = await callOllama(prompt, opts);
    return {
      entityId,
      tier: 3,
      description: response.trim(),
      confidence: 0.8,
    };
  } catch {
    return {
      entityId,
      tier: 3,
      description: `[Ollama unavailable] Could not generate summary`,
      confidence: 0,
    };
  }
}

function buildPrompt(sourceCode: string, context: string): string {
  return [
    "Summarize what this function does in 1-2 sentences.",
    "Focus on the business logic, not the implementation details.",
    "Be specific about what data is processed and what the output is.",
    "",
    context ? `Context: ${context}` : "",
    "",
    "```typescript",
    sourceCode,
    "```",
    "",
    "Summary:",
  ]
    .filter(Boolean)
    .join("\n");
}

async function callOllama(
  prompt: string,
  options: OllamaOptions,
): Promise<string> {
  const response = await fetch(`${options.baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: options.model,
      prompt,
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: 200,
      },
    }),
    signal: AbortSignal.timeout(options.timeout),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status}`);
  }

  const data = (await response.json()) as { response: string };
  return data.response;
}

export async function isOllamaAvailable(
  baseUrl: string = DEFAULT_OPTIONS.baseUrl,
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function tier3Summarize(
  entities: readonly { entityId: string; sourceCode: string; context: string }[],
  options?: Partial<OllamaOptions>,
  concurrency = 5,
): Promise<Summary[]> {
  const step = Math.max(1, Math.floor(concurrency));
  const results: Summary[] = [];
  for (let i = 0; i < entities.length; i += step) {
    const batch = entities.slice(i, i + step);
    const batchResults = await Promise.all(
      batch.map((e) =>
        summarizeWithOllama(e.entityId, e.sourceCode, e.context, options),
      ),
    );
    results.push(...batchResults);
  }
  return results;
}
