/**
 * Tier 3 summarization: cloud LLM API (Anthropic Claude or OpenAI-compatible).
 *
 * Fast (~0.5-1s per call with batching), requires API key.
 * Uses the same prompt template as Ollama for consistent output.
 */

import type { Summary } from "@mma/core";

export type LlmProvider = "anthropic" | "openai";

export interface LlmApiOptions {
  readonly provider: LlmProvider;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string; // For OpenAI-compatible endpoints
  readonly timeout: number;
  readonly maxTokens: number;
}

const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

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

async function callAnthropic(
  prompt: string,
  options: LlmApiOptions,
): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options.model || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: options.maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(options.timeout),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Anthropic API error: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    content: Array<{ text: string }>;
  };
  const text = data.content[0]?.text;
  if (!text) throw new Error("Anthropic API returned empty content");
  return text;
}

async function callOpenAI(
  prompt: string,
  options: LlmApiOptions,
): Promise<string> {
  const baseUrl = options.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options.model || DEFAULT_OPENAI_MODEL,
      max_tokens: options.maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(options.timeout),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI API error: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const text = data.choices[0]?.message?.content;
  if (!text) throw new Error("OpenAI API returned empty content");
  return text;
}

export async function summarizeWithLlmApi(
  entityId: string,
  sourceCode: string,
  context: string,
  options: LlmApiOptions,
): Promise<Summary> {
  const prompt = buildPrompt(sourceCode, context);

  try {
    const text =
      options.provider === "anthropic"
        ? await callAnthropic(prompt, options)
        : await callOpenAI(prompt, options);

    return {
      entityId,
      tier: 3,
      description: text.trim(),
      confidence: 0.8,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      entityId,
      tier: 3,
      description: `[LLM API error] ${message}`,
      confidence: 0,
    };
  }
}

export async function tier3SummarizeLlmApi(
  entities: readonly { entityId: string; sourceCode: string; context: string }[],
  options: LlmApiOptions,
  concurrency = 20,
): Promise<Summary[]> {
  const step = Math.max(1, Math.floor(concurrency));
  const results: Summary[] = [];
  for (let i = 0; i < entities.length; i += step) {
    const batch = entities.slice(i, i + step);
    const batchResults = await Promise.all(
      batch.map((e) =>
        summarizeWithLlmApi(e.entityId, e.sourceCode, e.context, options),
      ),
    );
    results.push(...batchResults);
  }
  return results;
}

export async function isLlmApiAvailable(
  options: Pick<LlmApiOptions, "provider" | "apiKey" | "baseUrl" | "timeout">,
): Promise<boolean> {
  try {
    if (options.provider === "anthropic") {
      const response = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(options.timeout ?? 5_000),
      });
      return response.ok;
    } else {
      const baseUrl = options.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
        },
        signal: AbortSignal.timeout(options.timeout ?? 5_000),
      });
      return response.ok;
    }
  } catch {
    return false;
  }
}
