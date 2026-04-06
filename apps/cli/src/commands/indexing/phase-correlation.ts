/**
 * Phase 7: Cross-repo correlation and cross-repo model analysis.
 */

import { runCorrelation, runCrossRepoModels } from "@mma/correlation";
import type { PipelineTracer } from "../../tracer.js";
import type { PipelineContext } from "./types.js";

export async function runPhaseCorrelation(
  ctx: PipelineContext,
  tracer: PipelineTracer,
): Promise<void> {
  const { log, kvStore, graphStore, options, repos, packageRoots, mirrorDir } = ctx;
  const verbose = options.verbose;

  if (repos.length <= 1) return;

  tracer.startPhase("Cross-repo Correlation");
  const correlationResult = await runCorrelation(kvStore, graphStore, {
    repos, packageRoots, mirrorDir, verbose,
  });
  if (verbose) {
    log(`  Cross-repo edges: ${correlationResult.counts.crossRepoEdges}`);
    log(`  Repo pairs: ${correlationResult.counts.repoPairs}`);
    log(`  Linchpins: ${correlationResult.counts.linchpins}`);
    log(`  SARIF findings: ${correlationResult.counts.sarifFindings}`);
  }
  tracer.record("crossRepoEdges", correlationResult.counts.crossRepoEdges);
  tracer.endPhase();

  // Phase 7b: Cross-repo model analysis
  tracer.startPhase("Cross-repo Models");
  const crossRepoModelsResult = await runCrossRepoModels(kvStore, {
    repos,
    crossRepoGraph: correlationResult.crossRepoGraph,
    serviceCorrelation: correlationResult.serviceCorrelation,
    graphStore,
    verbose,
  });
  if (verbose) {
    log(`  Shared flags: ${crossRepoModelsResult.counts.sharedFlags}`);
    log(`  Fault links: ${crossRepoModelsResult.counts.faultLinks}`);
    log(`  Catalog entries: ${crossRepoModelsResult.counts.catalogEntries}`);
    log(`  SARIF findings: ${crossRepoModelsResult.counts.sarifFindings}`);
  }
  tracer.endPhase();
}
