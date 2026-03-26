/**
 * Phase 6c: Functional service catalog generation.
 */

import type { RepoConfig, Summary } from "@mma/core";
import { buildServiceCatalog, generateDocumentation } from "@mma/model-functional";
import type { PipelineContext } from "./types.js";

export async function runPhaseFunctional(
  ctx: PipelineContext,
  repo: RepoConfig,
  summaryMap: Map<string, Summary>,
): Promise<void> {
  const { log, kvStore } = ctx;
  const services6c = ctx.servicesByRepo.get(repo.name);
  if (!services6c || services6c.length === 0) {
    log(`  [${repo.name}] [functional]: skipped (${!services6c ? "no services" : "0 services inferred"})`);
    return;
  }

  const phase6cRepoStart = performance.now();
  try {
    const logIndex = ctx.logIndexByRepo.get(repo.name);
    const svcSummaries = summaryMap.size > 0 ? summaryMap : new Map<string, Summary>();
    const svcLogIndex = logIndex ?? { repo: repo.name, templates: [] };
    const catalog = buildServiceCatalog(services6c, svcSummaries, svcLogIndex);
    const docs = generateDocumentation(catalog, svcSummaries);
    await kvStore.set(`docs:functional:${repo.name}`, docs);
    await kvStore.set(`catalog:${repo.name}`, JSON.stringify(catalog));
    log(`  [${repo.name}] [functional]: ${catalog.length} catalog entries, ${docs.length} chars of documentation`);
  } catch (error) {
    console.error(`  Failed to build service catalog for ${repo.name}:`, error);
  }
  ctx.phase6cTotalMs += Math.round(performance.now() - phase6cRepoStart);
}
