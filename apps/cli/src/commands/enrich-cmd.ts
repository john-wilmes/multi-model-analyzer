/**
 * `mma enrich` command: post-hoc LLM enrichment of cached summaries.
 *
 * Reads Tier 1 summaries from KV (written during `mma index`), applies
 * Tier 3 (Haiku) for low-confidence entity summaries and Tier 4 (Sonnet)
 * for service-level summaries, then re-indexes enriched results into the
 * search store.
 *
 * This is the background/CI counterpart to the --enrich flag on `mma index`.
 * It is safe to run repeatedly — both tier-3 and tier-4 are KV-cached so
 * previously enriched entities are served from cache without extra API calls.
 */

import type { KVStore, SearchStore } from "@mma/storage";
import {
  shouldEscalateToTier3,
  tier3BatchSummarize,
  tier4BatchSummarize,
  SONNET_DEFAULTS,
} from "@mma/summarization";
import type { HaikuOptions, ServiceSummaryInput } from "@mma/summarization";
import type { Summary, ServiceCatalogEntry } from "@mma/core";

export interface EnrichOptions {
  readonly kvStore: KVStore;
  readonly searchStore: SearchStore;
  readonly apiKey: string;
  readonly maxApiCalls?: number;
  /** When set, only enrich this single repo. */
  readonly repo?: string;
  readonly verbose: boolean;
}

export interface EnrichResult {
  readonly reposEnriched: number;
  readonly tier3Count: number;
  readonly tier4Count: number;
  readonly apiCallsMade: number;
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

  // Discover all repos that have been indexed (have t1 cache entries)
  const allT1Keys = await options.kvStore.keys(T1_PREFIX);
  let repos = extractRepoNames(allT1Keys);

  if (options.repo) {
    repos = repos.filter((r) => r === options.repo);
    if (repos.length === 0) {
      log(`[enrich] No cached summaries found for repo: ${options.repo}`);
      return { reposEnriched: 0, tier3Count: 0, tier4Count: 0, apiCallsMade: 0 };
    }
  }

  log(`[enrich] Found ${repos.length} repo(s) to enrich: ${repos.join(", ")}`);

  let totalTier3Count = 0;
  let totalTier4Count = 0;
  let totalApiCallsMade = 0;
  let reposEnriched = 0;

  // Remaining API budget across all repos (shared)
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

    // Tier 3: Haiku for low-confidence entities not already t3-cached
    let tier3Count = 0;
    if (budgetRemaining === undefined || budgetRemaining > 0) {
      const tier3Candidates = (
        await Promise.all(
          [...summaryMap.entries()]
            .filter(([, s]) => shouldEscalateToTier3(s, undefined))
            .map(async ([entityId, s]) => {
              // Skip if already t3-cached
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
        log(`[enrich]   Tier 3 (Haiku): upgrading ${capped.length} low-confidence summaries`);

        const haikuOptions: HaikuOptions = {
          kvStore: options.kvStore,
        };

        const tier3Results = await tier3BatchSummarize(capped, options.apiKey, haikuOptions);

        for (const s of tier3Results) {
          if (s.confidence > 0) {
            summaryMap.set(s.entityId, s);
            tier3Count++;
          }
        }

        // Each tier3 call is 1 API call per entity (no batching overhead)
        const tier3ApiCalls = tier3Results.filter((s) => s.confidence > 0).length;
        totalApiCallsMade += tier3ApiCalls;
        if (budgetRemaining !== undefined) {
          budgetRemaining = Math.max(0, budgetRemaining - tier3ApiCalls);
        }
      }
    }

    totalTier3Count += tier3Count;
    log(`[enrich]   Tier 3: ${tier3Count} summaries upgraded`);

    // Tier 4: Sonnet for service-level summaries
    let tier4Count = 0;
    if (budgetRemaining === undefined || budgetRemaining > 0) {
      const catalogRaw = await options.kvStore.get(`catalog:${repoName}`);
      if (catalogRaw) {
        const catalog = JSON.parse(catalogRaw) as ServiceCatalogEntry[];

        if (catalog.length > 0) {
          // Build ServiceSummaryInput from catalog entries and current summaryMap
          const inputs: ServiceSummaryInput[] = catalog.map((svc) => ({
            entityId: `service:${svc.name}`,
            serviceName: svc.name,
            methodSummaries: [...summaryMap.values()]
              .filter((s) => s.entityId.includes(svc.name))
              .slice(0, 20)
              .map((s) => s.description),
            dependencies: [...svc.dependencies],
            entryPoints: svc.apiSurface.map((ep) => `${ep.method} ${ep.path}`),
          }));

          log(`[enrich]   Tier 4 (Sonnet): summarizing ${inputs.length} service(s)`);

          const tier4Result = await tier4BatchSummarize(inputs, {
            ...SONNET_DEFAULTS,
            apiKey: options.apiKey,
            kvStore: options.kvStore,
            maxApiCalls: budgetRemaining,
          });

          for (const s of tier4Result.summaries) {
            if (s.confidence > 0) {
              summaryMap.set(s.entityId, s);
              tier4Count++;
            }
          }

          totalApiCallsMade += tier4Result.apiCallsMade;
          if (budgetRemaining !== undefined) {
            budgetRemaining = Math.max(0, budgetRemaining - tier4Result.apiCallsMade);
          }
        }
      } else {
        log(`[enrich]   No service catalog found for ${repoName}, skipping tier 4`);
      }
    }

    totalTier4Count += tier4Count;
    log(`[enrich]   Tier 4: ${tier4Count} service summaries generated`);

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
    tier4Count: totalTier4Count,
    apiCallsMade: totalApiCallsMade,
  };
}
