/**
 * `mma enrich` command: post-hoc LLM enrichment of cached summaries.
 *
 * Reads Tier 1 summaries from KV (written during `mma index`), applies
 * Tier 3 (Ollama) for low-confidence entity summaries, then re-indexes
 * enriched results into the search store.
 *
 * This is the background/CI counterpart to the --enrich flag on `mma index`.
 * It is safe to run repeatedly — tier-3 results are KV-cached so previously
 * enriched entities are served from cache without extra LLM calls.
 */

import type { KVStore, SearchStore } from "@mma/storage";
import {
  shouldEscalateToTier3,
  tier3Summarize as ollamaTier3Summarize,
  isOllamaAvailable,
  tier3SummarizeLlmApi,
  isLlmApiAvailable,
} from "@mma/summarization";
import type { OllamaOptions, LlmProvider } from "@mma/summarization";
import type { Summary } from "@mma/core";

export interface EnrichOptions {
  readonly kvStore: KVStore;
  readonly searchStore: SearchStore;
  readonly maxApiCalls?: number;
  /** When set, only enrich this single repo. */
  readonly repo?: string;
  readonly verbose: boolean;
  readonly ollamaUrl?: string;
  readonly ollamaModel?: string;
  /** Use cloud LLM instead of Ollama (anthropic or openai). */
  readonly llmProvider?: LlmProvider;
  readonly llmApiKey?: string;
  readonly llmModel?: string;
}

export interface EnrichResult {
  readonly reposEnriched: number;
  readonly tier3Count: number;
}

const T1_PREFIX = "summary:t1:";
const T3_PREFIX = "summary:t3:";

/**
 * Discover distinct repo names from `summary:t1:<repo>:<path>:<hash>` keys.
 * Keys have at least 3 colon-separated segments after the prefix.
 */
function extractRepoNames(keys: string[]): string[] {
  const repos = new Set<string>();
  for (const key of keys) {
    // Key format: summary:t1:<repo>:<rest>
    const withoutPrefix = key.slice(T1_PREFIX.length);
    const colonIdx = withoutPrefix.indexOf(":");
    if (colonIdx > 0) {
      repos.add(withoutPrefix.slice(0, colonIdx));
    }
  }
  return [...repos];
}

export async function enrichCommand(options: EnrichOptions): Promise<EnrichResult> {
  const log = options.verbose ? console.log.bind(console) : () => {};

  const cloudProvider = options.llmProvider === "anthropic" || options.llmProvider === "openai"
    ? options.llmProvider
    : undefined;
  const useCloudLlm = cloudProvider !== undefined;

  if (useCloudLlm) {
    const apiKey = options.llmApiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(`No API key for ${cloudProvider}. Set --llm-api-key or ANTHROPIC_API_KEY env var.`);
    }
    const available = await isLlmApiAvailable({ provider: cloudProvider, apiKey, timeout: 5_000 });
    if (!available) {
      throw new Error(`${options.llmProvider} API is not reachable. Check your API key and network.`);
    }
    log(`[enrich] ${options.llmProvider} API available`);
  } else {
    // Ollama availability check
    const ollamaUrl = options.ollamaUrl ?? "http://localhost:11434";
    const available = await isOllamaAvailable(ollamaUrl);
    if (!available) {
      throw new Error(`Ollama is not reachable at ${ollamaUrl}. Start Ollama or specify --ollama-url.`);
    }
    log(`[enrich] Ollama available at ${ollamaUrl}`);
  }

  // Discover all repos that have been indexed (have t1 cache entries)
  const allT1Keys = await options.kvStore.keys(T1_PREFIX);
  let repos = extractRepoNames(allT1Keys);

  if (options.repo) {
    repos = repos.filter((r) => r === options.repo);
    if (repos.length === 0) {
      log(`[enrich] No cached summaries found for repo: ${options.repo}`);
      return { reposEnriched: 0, tier3Count: 0 };
    }
  }

  log(`[enrich] Found ${repos.length} repo(s) to enrich: ${repos.join(", ")}`);

  let totalTier3Count = 0;
  let reposEnriched = 0;

  // Remaining budget across all repos (shared)
  let budgetRemaining = options.maxApiCalls;

  for (const repoName of repos) {
    log(`[enrich] Processing repo: ${repoName}`);

    // Collect all t1 summaries for this repo
    const repoT1Keys = allT1Keys.filter((k) => k.startsWith(`${T1_PREFIX}${repoName}:`));
    const summaryMap = new Map<string, Summary>();

    for (const key of repoT1Keys) {
      const raw = await options.kvStore.get(key);
      if (!raw) continue;
      try {
        const summaries = JSON.parse(raw) as Summary[];
        for (const s of summaries) {
          // Keep highest-tier (or first encountered) summary per entity
          const existing = summaryMap.get(s.entityId);
          if (!existing || s.tier > existing.tier) {
            summaryMap.set(s.entityId, s);
          }
        }
      } catch {
        // Corrupted cache entry — skip
      }
    }

    if (summaryMap.size === 0) {
      log(`[enrich]   No summaries found for ${repoName}, skipping`);
      continue;
    }

    log(`[enrich]   Loaded ${summaryMap.size} tier-1 summaries`);

    // Tier 3: Ollama for low-confidence entities not already t3-cached
    let tier3Count = 0;
    if (budgetRemaining === undefined || budgetRemaining > 0) {
      const tier3Candidates = (
        await Promise.all(
          [...summaryMap.entries()]
            .filter(([, s]) => shouldEscalateToTier3(s, undefined))
            .map(async ([entityId, s]) => {
              const alreadyCached = await options.kvStore.has(T3_PREFIX + entityId);
              if (alreadyCached) return null;
              return { entityId, description: s.description, context: entityId };
            }),
        )
      ).filter((c): c is NonNullable<typeof c> => c !== null);

      const capped =
        budgetRemaining !== undefined
          ? tier3Candidates.slice(0, budgetRemaining)
          : tier3Candidates;

      if (capped.length > 0) {
        const entities = capped.map((c) => ({
          entityId: c.entityId,
          sourceCode: c.description,
          context: c.context,
        }));
        let tier3Results;
        if (useCloudLlm) {
          log(`[enrich]   Tier 3 (${cloudProvider}): upgrading ${capped.length} low-confidence summaries`);
          const apiKey = options.llmApiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
          const DEFAULT_MODELS: Record<LlmProvider, string> = {
            anthropic: "claude-haiku-4-5-20251001",
            openai: "gpt-4o-mini",
          };
          tier3Results = await tier3SummarizeLlmApi(entities, {
            provider: cloudProvider,
            apiKey,
            model: options.llmModel ?? DEFAULT_MODELS[cloudProvider],
            timeout: 30_000,
            maxTokens: 256,
          }, 20);
        } else {
          log(`[enrich]   Tier 3 (Ollama): upgrading ${capped.length} low-confidence summaries`);
          const ollamaOpts: Partial<OllamaOptions> = {
            ...(options.ollamaUrl ? { baseUrl: options.ollamaUrl } : {}),
            ...(options.ollamaModel ? { model: options.ollamaModel } : {}),
          };
          tier3Results = await ollamaTier3Summarize(entities, ollamaOpts);
        }
        for (const s of tier3Results) {
          if (s.confidence > 0) {
            summaryMap.set(s.entityId, s);
            tier3Count++;
          }
        }
        if (budgetRemaining !== undefined) {
          budgetRemaining = Math.max(0, budgetRemaining - capped.length);
        }
      }
    }

    totalTier3Count += tier3Count;
    log(`[enrich]   Tier 3: ${tier3Count} summaries upgraded`);

    // Re-index all enriched summaries into the search store
    const searchDocs = [...summaryMap.values()].map((s) => ({
      id: s.entityId,
      content: `${s.entityId} ${s.description}`,
      metadata: { tier: String(s.tier), repo: repoName },
    }));

    await options.searchStore.index(searchDocs);
    log(`[enrich]   Re-indexed ${searchDocs.length} summaries into search store`);

    reposEnriched++;
  }

  return {
    reposEnriched,
    tier3Count: totalTier3Count,
  };
}
