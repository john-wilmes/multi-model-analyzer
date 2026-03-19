/**
 * Cross-repo fault propagation detection.
 *
 * Uses service links as a proxy for cross-service call paths and checks
 * whether both repos on a link have fault trees, indicating potential
 * cascading failure paths.
 */

import type { KVStore } from "@mma/storage";
import type { RepoConfig, FaultTree, SarifResult } from "@mma/core";
import { createSarifResult, createLogicalLocation } from "@mma/core";
import type { ServiceCorrelationResult, CrossRepoFaultLink, CrossRepoFaultResult } from "./types.js";

export async function detectCrossRepoFaults(
  kvStore: KVStore,
  repos: readonly RepoConfig[],
  serviceCorrelation: ServiceCorrelationResult,
): Promise<CrossRepoFaultResult> {
  // 1. Load faultTrees:<repo> from KV
  const faultTreesByRepo = new Map<string, FaultTree[]>();
  for (const repo of repos) {
    const raw = await kvStore.get(`faultTrees:${repo.name}`);
    if (!raw) continue;
    try {
      const trees = JSON.parse(raw) as FaultTree[];
      if (trees.length > 0) {
        faultTreesByRepo.set(repo.name, trees);
      }
    } catch { /* skip malformed */ }
  }

  // 2. For each service link, find repo pairs that both have fault trees
  const faultLinks: CrossRepoFaultLink[] = [];
  const sarifResults: SarifResult[] = [];
  const seen = new Set<string>(); // deduplicate repo pairs per endpoint

  for (const link of serviceCorrelation.links) {
    const producerRepos = [...link.producers.keys()];
    const consumerRepos = [...link.consumers.keys()];

    for (const pRepo of producerRepos) {
      const pTrees = faultTreesByRepo.get(pRepo);
      if (!pTrees) continue;

      for (const cRepo of consumerRepos) {
        if (pRepo === cRepo) continue;
        const cTrees = faultTreesByRepo.get(cRepo);
        if (!cTrees) continue;

        const key = `${link.endpoint}:${pRepo}->${cRepo}`;
        if (seen.has(key)) continue;
        seen.add(key);

        faultLinks.push({
          endpoint: link.endpoint,
          sourceRepo: pRepo,
          targetRepo: cRepo,
          sourceFaultTreeCount: pTrees.length,
          targetFaultTreeCount: cTrees.length,
        });

        const location = {
          logicalLocations: [
            createLogicalLocation(pRepo, link.endpoint, undefined, "service"),
          ],
        };
        const relatedLocations = [{
          logicalLocations: [
            createLogicalLocation(cRepo, link.endpoint, undefined, "service"),
          ],
        }];

        sarifResults.push(
          createSarifResult(
            "cross-repo/cascading-fault",
            "warning",
            `Error path may span repos "${pRepo}" → "${cRepo}" via service "${link.endpoint}". ` +
            `Producer has ${pTrees.length} fault tree(s), consumer has ${cTrees.length} fault tree(s).`,
            {
              locations: [location],
              relatedLocations,
              properties: {
                endpoint: link.endpoint,
                sourceRepo: pRepo,
                targetRepo: cRepo,
                sourceFaultTreeCount: pTrees.length,
                targetFaultTreeCount: cTrees.length,
              },
            },
          ),
        );
      }
    }
  }

  return { faultLinks, sarifResults };
}
