/**
 * Phase 6b: Tier-1 / tier-2 / tier-3 summarization and search indexing.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoConfig, Summary } from "@mma/core";
import { getFileContent, getFileContentBatch } from "@mma/ingestion";
import {
  tier1Summarize,
  tier2Summarize,
  shouldEscalateToTier3,
  tier3Summarize as ollamaTier3Summarize,
  tier3SummarizeLlmApi,
} from "@mma/summarization";
import type { OllamaOptions, LlmApiOptions } from "@mma/summarization";
import { ProgressTracker } from "../progress.js";
import { checkBareRepo, resolveCommitForBare } from "./bare-repo.js";
import type { PipelineContext } from "./types.js";

export async function runPhaseSummarization(
  ctx: PipelineContext,
  repo: RepoConfig,
  sourceTextCache: Map<string, string>,
): Promise<Map<string, Summary>> {
  const { log, mirrorDir, kvStore, searchStore, options, changeSets, namingByRepo, sharedApiBudget } = ctx;
  const repoPath = repo.localPath ?? join(mirrorDir, `${repo.name}.git`);
  const parsedFiles = ctx.parsedFilesByRepo.get(repo.name);

  const summaryMap = new Map<string, Summary>();

  if (!parsedFiles) {
    log(`  [${repo.name}] Skipping summarization (no parsed files)`);
    return summaryMap;
  }

  const phase6bRepoStart = performance.now();
  try {
    const namingResult = namingByRepo.get(repo.name);

    // Tier 1: template-based summaries from AST (batched parallel I/O, cached by contentHash)
    let tier1ReadErrors = 0;
    let tier1CacheHits = 0;
    const BATCH_SIZE = 20;
    // Tier-3 snippets are loaded lazily at tier-3 time to avoid OOM on large repos.
    const MAX_SNIPPET_LINES = 30;
    const isBareForTier1 = await checkBareRepo(repoPath);
    const bareCommitForTier1 = isBareForTier1
      ? await resolveCommitForBare(repoPath, changeSets, repo.name)
      : undefined;
    const tier1Progress = new ProgressTracker(parsedFiles.length);

    for (let batchStart = 0; batchStart < parsedFiles.length; batchStart += BATCH_SIZE) {
      const batch = parsedFiles.slice(batchStart, batchStart + BATCH_SIZE);

      // For bare repos: bulk-fetch uncached files in this batch via git cat-file --batch
      if (isBareForTier1 && bareCommitForTier1) {
        // Filter out files already in the source-text cache, then check the
        // KV summary cache in parallel for the remainder.
        const notInMemory = batch.filter((pf) => !sourceTextCache.has(pf.path));
        const cacheChecks = await Promise.all(
          notInMemory.map(async (pf) => {
            const cacheKey = `summary:t1:${repo.name}:${pf.path}:${pf.contentHash}`;
            const hit = await kvStore.get(cacheKey);
            return { pf, hit };
          }),
        );
        const uncached = cacheChecks.filter(({ hit }) => !hit).map(({ pf }) => pf.path);
        if (uncached.length > 0) {
          try {
            const fetched = await getFileContentBatch(repoPath, bareCommitForTier1, uncached);
            for (const [p, c] of fetched) sourceTextCache.set(p, c);
          } catch (err) {
            log(`[warn] bulk fetch failed for ${repo.name}, falling through to per-file reads: ${String(err)}`);
          }
        }
      }

      const results = await Promise.all(
        batch.map(async (pf) => {
          const cacheKey = `summary:t1:${repo.name}:${pf.path}:${pf.contentHash}`;
          const cached = await kvStore.get(cacheKey);
          if (cached) {
            tier1CacheHits++;
            try {
              return { summaries: JSON.parse(cached) as Summary[], symbols: pf.symbols, filePath: pf.path };
            } catch {
              // Corrupted cache entry; re-generate below
            }
          }
          try {
            const cachedSource = sourceTextCache.get(pf.path);
            sourceTextCache.delete(pf.path); // free after use
            const sourceText = cachedSource !== undefined
              ? cachedSource
              : isBareForTier1 && bareCommitForTier1
                ? await getFileContent(repoPath, bareCommitForTier1, pf.path, { timeoutMs: 30_000 })
                : await readFile(join(repoPath, pf.path), "utf-8");
            const summaries = tier1Summarize(pf.symbols, pf.path, sourceText);
            if (summaries.length > 0) {
              // Delete any stale cache entries for this file (old contentHash keys
              // from previous runs). The prefix includes the trailing colon so it
              // matches only entries for this exact repo:filePath pair.
              await kvStore.deleteByPrefix(`summary:t1:${repo.name}:${pf.path}:`);
              await kvStore.set(cacheKey, JSON.stringify(summaries));
            }
            return { summaries, symbols: pf.symbols, filePath: pf.path };
          } catch {
            tier1ReadErrors++;
            return { summaries: [] as Summary[], symbols: pf.symbols, filePath: pf.path };
          }
        }),
      );
      for (const { summaries: tier1 } of results) {
        for (const s of tier1) {
          summaryMap.set(s.entityId, s);
        }
      }
      tier1Progress.tick(batch.length);
      const processed = Math.min(batchStart + BATCH_SIZE, parsedFiles.length);
      if (batchStart === 0 || processed % 1000 < BATCH_SIZE || processed === parsedFiles.length) {
        log(`    [tier-1] ${tier1Progress.format()}`);
      }
    }
    if (tier1CacheHits > 0) {
      log(`    [tier-1] ${tier1CacheHits} files served from cache`);
    }
    if (tier1ReadErrors > 0) {
      log(`    warning: ${tier1ReadErrors} files could not be read for tier-1 summarization`);
    }

    const tier1Count = summaryMap.size;
    sourceTextCache.clear(); // free memory after tier-1

    // Tier 2: naming-based summaries (overwrites tier 1 for same entityId)
    let tier2Total = 0;
    let tier2Upgraded = 0;
    if (namingResult) {
      const tier2 = tier2Summarize(namingResult.methods);
      tier2Total = tier2.length;
      for (const s of tier2) {
        if (summaryMap.has(s.entityId)) tier2Upgraded++;
        summaryMap.set(s.entityId, s);
      }
    }

    // Tier 3: LLM (cloud API or Ollama) for low-confidence method summaries (lazy snippet loading)
    // Build file→contentHash index for content-addressed tier-3 caching
    const fileHashIndex = new Map<string, string>();
    if (parsedFiles) {
      for (const pf of parsedFiles) {
        fileHashIndex.set(pf.path, pf.contentHash);
      }
    }
    let tier3Count = 0;
    let tier3CacheHits = 0;
    if (options.enrich && (!sharedApiBudget || sharedApiBudget.remaining > 0)) {
      const tier3Raw = [...summaryMap.entries()]
        .filter(([, s]) => shouldEscalateToTier3(s, undefined));
      const tier3CacheChecks = await Promise.all(
        tier3Raw.map(async ([entityId, s]) => {
          const filePath = entityId.split("#")[0];
          const hash = filePath ? fileHashIndex.get(filePath) : undefined;
          // Content-addressed cache: skip LLM call if file content hasn't changed
          const cacheKey = hash
            ? `summary:t3:${repo.name}:${entityId}:${hash}`
            : `summary:t3:${repo.name}:${entityId}`;
          const cached = await kvStore.has(cacheKey);
          if (cached) tier3CacheHits++;
          return cached ? null : [entityId, s] as [string, typeof s];
        })
      );
      let tier3Candidates = tier3CacheChecks.filter((r): r is [string, (typeof tier3Raw)[number][1]] => r !== null);
      // Atomically reserve budget before async work
      if (sharedApiBudget) {
        const granted = sharedApiBudget.reserve(tier3Candidates.length);
        tier3Candidates = tier3Candidates.slice(0, granted);
      }
      if (tier3Candidates.length > 0) {
        const tier3Provider = options.llmProvider ?? "ollama";
        log(`    Tier 3 (${tier3Provider}): upgrading ${tier3Candidates.length} low-confidence summaries`);

        // Lazily load source snippets only for tier-3 candidates (avoids OOM on large repos)
        const isBareForTier3 = await checkBareRepo(repoPath);
        const bareCommitForTier3 = isBareForTier3
          ? await resolveCommitForBare(repoPath, changeSets, repo.name)
          : undefined;

        // Build a symbol start-line index from parsedFiles
        const symbolLineIndex = new Map<string, number>();
        for (const pf of parsedFiles) {
          for (const sym of pf.symbols) {
            if (sym.kind !== "function" && sym.kind !== "method" && sym.kind !== "class") continue;
            const eid = sym.containerName
              ? `${pf.path}#${sym.containerName}.${sym.name}`
              : `${pf.path}#${sym.name}`;
            symbolLineIndex.set(eid, sym.startLine);
          }
        }

        const ollamaOpts: Partial<OllamaOptions> = {
          ...(options.ollamaUrl ? { baseUrl: options.ollamaUrl } : {}),
          ...(options.ollamaModel ? { model: options.ollamaModel } : {}),
        };

        // Process tier-3 in chunks of 200 to bound memory (load snippets per chunk, then free)
        const TIER3_CHUNK = 200;
        const tier3Progress = new ProgressTracker(tier3Candidates.length);
        for (let ci = 0; ci < tier3Candidates.length; ci += TIER3_CHUNK) {
          const chunk = tier3Candidates.slice(ci, ci + TIER3_CHUNK);

          // Group this chunk's candidates by file
          const chunkByFile = new Map<string, { entityId: string }[]>();
          for (const [entityId] of chunk) {
            const [filePath, symPart] = entityId.split("#");
            if (!filePath || !symPart) continue;
            let list = chunkByFile.get(filePath);
            if (!list) { list = []; chunkByFile.set(filePath, list); }
            list.push({ entityId });
          }

          // Load snippets for this chunk only
          const snippetMap = new Map<string, string>();
          const filePaths = [...chunkByFile.keys()];
          if (isBareForTier3 && bareCommitForTier3 && filePaths.length > 0) {
            try {
              const fetched = await getFileContentBatch(repoPath, bareCommitForTier3, filePaths);
              for (const [fp, content] of fetched) {
                const lines = content.split("\n");
                for (const { entityId } of chunkByFile.get(fp) ?? []) {
                  const startLine = symbolLineIndex.get(entityId);
                  if (startLine === undefined) continue;
                  const start = Math.max(0, startLine - 1);
                  const end = Math.min(lines.length, start + MAX_SNIPPET_LINES);
                  snippetMap.set(entityId, lines.slice(start, end).join("\n"));
                }
              }
            } catch {
              // Fall through — use entityId as context
            }
          } else {
            for (const [fp, candidates] of chunkByFile) {
              try {
                const content = await readFile(join(repoPath, fp), "utf-8");
                const lines = content.split("\n");
                for (const { entityId } of candidates) {
                  const startLine = symbolLineIndex.get(entityId);
                  if (startLine === undefined) continue;
                  const start = Math.max(0, startLine - 1);
                  const end = Math.min(lines.length, start + MAX_SNIPPET_LINES);
                  snippetMap.set(entityId, lines.slice(start, end).join("\n"));
                }
              } catch {
                // File not readable — skip
              }
            }
          }

          const tier3Entities = chunk.map(([entityId]) => ({
            entityId,
            sourceCode: snippetMap.get(entityId) ?? entityId,
            context: entityId,
          }));

          let tier3Results;
          if (tier3Provider === "anthropic" || tier3Provider === "openai") {
            const resolvedApiKey =
              options.llmApiKey ??
              (tier3Provider === "anthropic"
                ? process.env.ANTHROPIC_API_KEY
                : process.env.OPENAI_API_KEY) ??
              "";
            const llmOpts: LlmApiOptions = {
              provider: tier3Provider,
              apiKey: resolvedApiKey,
              model: options.llmModel ?? (tier3Provider === "anthropic" ? "claude-haiku-4-5-20251001" : "gpt-4o-mini"),
              timeout: 30_000,
              maxTokens: 200,
            };
            tier3Results = await tier3SummarizeLlmApi(tier3Entities, llmOpts, 20);
          } else {
            tier3Results = await ollamaTier3Summarize(tier3Entities, ollamaOpts);
          }
          for (const s of tier3Results) {
            if (s.confidence > 0) {
              summaryMap.set(s.entityId, s);
              tier3Count++;
              const filePath = s.entityId.split("#")[0];
              const hash = filePath ? fileHashIndex.get(filePath) : undefined;
              const cacheKey = hash
                ? `summary:t3:${repo.name}:${s.entityId}:${hash}`
                : `summary:t3:${repo.name}:${s.entityId}`;
              await kvStore.set(cacheKey, JSON.stringify(s));
            }
          }
          tier3Progress.tick(chunk.length);
          if (ci % 1000 < TIER3_CHUNK) {
            log(`    [tier-3] ${tier3Progress.format()}`);
          }
        }
      }
    }

    if (tier3CacheHits > 0) {
      log(`    [tier-3] ${tier3CacheHits} entities served from cache`);
    }

    // Index summaries in search store for query support (batched to limit memory)
    const SEARCH_BATCH = 1000;
    let searchDocs: Array<{
      id: string;
      content: string;
      metadata: { tier: string; repo: string };
    }> = [];
    for (const s of summaryMap.values()) {
      // Extract bare symbol name for better BM25 recall (e.g., "signIn" from "src/auth.ts#AuthService.signIn")
      const hashPart = s.entityId.split("#")[1] ?? "";
      const symbolName = hashPart.split(".").pop() ?? "";
      const containerName = hashPart.includes(".") ? hashPart.split(".")[0] ?? "" : "";
      searchDocs.push({
        id: s.entityId,
        content: [symbolName, containerName, s.entityId, s.description].filter(Boolean).join(" "),
        metadata: { tier: String(s.tier), repo: repo.name },
      });
      if (searchDocs.length === SEARCH_BATCH) {
        await searchStore.index(searchDocs);
        searchDocs = [];
      }
    }
    if (searchDocs.length > 0) {
      await searchStore.index(searchDocs);
    }

    const tierBreakdown = [
      `${tier1Count} tier-1`,
      `${tier2Total} tier-2 (${tier2Upgraded} upgraded)`,
      tier3Count > 0 ? `${tier3Count} tier-3` : null,
    ].filter(Boolean).join(", ");
    log(`  [${repo.name}] Summaries: ${tierBreakdown}, ${summaryMap.size} total`);
  } catch (error) {
    console.error(`  Failed to generate summaries for ${repo.name}:`, error);
    ctx.failedRepoNames.add(repo.name);
  }
  ctx.phase6bTotalMs += Math.round(performance.now() - phase6bRepoStart);

  return summaryMap;
}
