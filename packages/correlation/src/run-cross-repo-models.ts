/**
 * Cross-repo model orchestrator.
 *
 * Runs all three cross-repo model analyses (features, faults, catalog),
 * persists results to KV store, and returns a combined result.
 */

import type { KVStore } from "@mma/storage";
import type { SarifResult } from "@mma/core";
import type { CrossRepoModelsOptions, CrossRepoModelsResult } from "./types.js";
import { detectCrossRepoFeatures } from "./cross-repo-features.js";
import { detectCrossRepoFaults } from "./cross-repo-faults.js";
import { buildSystemCatalog } from "./cross-repo-catalog.js";

export async function runCrossRepoModels(
  kvStore: KVStore,
  options: CrossRepoModelsOptions,
): Promise<CrossRepoModelsResult> {
  const { repos, crossRepoGraph, serviceCorrelation, verbose } = options;

  // Run all three detectors
  const features = await detectCrossRepoFeatures(kvStore, repos, crossRepoGraph);
  const faults = await detectCrossRepoFaults(kvStore, repos, serviceCorrelation);
  const catalog = await buildSystemCatalog(kvStore, repos, crossRepoGraph, serviceCorrelation);

  // Collect all SARIF
  const sarifResults: SarifResult[] = [
    ...features.sarifResults,
    ...faults.sarifResults,
    ...catalog.sarifResults,
  ];

  // Persist to KV
  await kvStore.set("cross-repo:features", JSON.stringify(features));
  await kvStore.set("cross-repo:faults", JSON.stringify(faults));
  await kvStore.set("cross-repo:catalog", JSON.stringify(catalog));
  await kvStore.set("sarif:cross-repo-models", JSON.stringify(sarifResults));

  const counts = {
    sharedFlags: features.sharedFlags.length,
    faultLinks: faults.faultLinks.length,
    catalogEntries: catalog.entries.length,
    sarifFindings: sarifResults.length,
  };

  if (verbose) {
    console.log(
      `[cross-repo-models] sharedFlags=${counts.sharedFlags} faultLinks=${counts.faultLinks}` +
      ` catalogEntries=${counts.catalogEntries} sarif=${counts.sarifFindings}`,
    );
  }

  return { features, faults, catalog, sarifResults, counts };
}
