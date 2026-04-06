/**
 * Cross-repo fault propagation detection.
 *
 * Uses service links as a proxy for cross-service call paths and checks
 * whether both repos on a link have fault trees, indicating potential
 * cascading failure paths.
 */

import type { KVStore, GraphStore } from "@mma/storage";
import type { RepoConfig, FaultTree, SarifResult } from "@mma/core";
import { createSarifResult, createLogicalLocation } from "@mma/core";
import type { ServiceCorrelationResult, CrossRepoFaultLink, CrossRepoFaultResult } from "./types.js";

export async function detectCrossRepoFaults(
  kvStore: KVStore,
  repos: readonly RepoConfig[],
  serviceCorrelation: ServiceCorrelationResult,
  graphStore?: GraphStore,
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

  // 3. Fallback: use cross-repo import edges when no service-call producer/consumer pairs exist
  if (graphStore && faultLinks.length === 0) {
    const importEdges = await graphStore.getEdgesByKind("imports");
    // Count imports per (sourceRepo, targetRepo) pair
    const importCounts = new Map<string, number>();
    for (const edge of importEdges) {
      const sourceRepo = edge.repo ?? edge.source.split(":")[0];
      const targetRepo = edge.target.split(":")[0];
      if (!sourceRepo || !targetRepo || sourceRepo === targetRepo) continue;
      const pairKey = `${sourceRepo}:${targetRepo}`;
      importCounts.set(pairKey, (importCounts.get(pairKey) ?? 0) + 1);
    }

    // Build a set of already-covered pairs for O(1) lookup
    const coveredPairs = new Set(faultLinks.map((fl) => `${fl.sourceRepo}:${fl.targetRepo}`));

    for (const [pairKey, importCount] of importCounts) {
      const colonIdx = pairKey.indexOf(":");
      const sourceRepo = pairKey.slice(0, colonIdx);
      const targetRepo = pairKey.slice(colonIdx + 1);

      const sourceTrees = faultTreesByRepo.get(sourceRepo);
      if (!sourceTrees) continue;
      const targetTrees = faultTreesByRepo.get(targetRepo);
      if (!targetTrees) continue;

      // Skip if already covered by a service-call link
      if (coveredPairs.has(pairKey)) continue;

      faultLinks.push({
        endpoint: targetRepo,
        sourceRepo,
        targetRepo,
        sourceFaultTreeCount: sourceTrees.length,
        targetFaultTreeCount: targetTrees.length,
      });

      const location = {
        logicalLocations: [
          createLogicalLocation(sourceRepo, targetRepo, undefined, "module"),
        ],
      };
      const relatedLocations = [{
        logicalLocations: [
          createLogicalLocation(targetRepo, targetRepo, undefined, "module"),
        ],
      }];

      sarifResults.push(
        createSarifResult(
          "cross-repo/cascading-fault",
          "warning",
          `Import dependency: Repo "${sourceRepo}" imports from repo "${targetRepo}". ` +
          `Fault in "${targetRepo}" can cascade to "${sourceRepo}" via ${importCount} import(s). ` +
          `"${sourceRepo}" has ${sourceTrees.length} fault tree(s), ` +
          `"${targetRepo}" has ${targetTrees.length} fault tree(s).`,
          {
            locations: [location],
            relatedLocations,
            properties: {
              endpoint: targetRepo,
              sourceRepo,
              targetRepo,
              sourceFaultTreeCount: sourceTrees.length,
              targetFaultTreeCount: targetTrees.length,
              importCount,
              detectionMethod: "import-edge",
            },
          },
        ),
      );
    }
  }

  return { faultLinks, sarifResults };
}
