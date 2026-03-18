/**
 * Cross-repo feature flag coordination detection.
 *
 * Identifies feature flags shared across 2+ repos and checks whether
 * the repos are coordinated via a dependency edge in the cross-repo graph.
 */

import type { KVStore } from "@mma/storage";
import type { RepoConfig, FlagInventory, SarifResult } from "@mma/core";
import { createSarifResult, createLogicalLocation } from "@mma/core";
import type { CrossRepoGraph, CrossRepoFeatureResult } from "./types.js";

export async function detectCrossRepoFeatures(
  kvStore: KVStore,
  repos: readonly RepoConfig[],
  graph: CrossRepoGraph,
): Promise<CrossRepoFeatureResult> {
  // 1. Load flags:<repo> from KV for each repo
  const flagsByName = new Map<string, Set<string>>(); // flagName -> Set<repo>

  for (const repo of repos) {
    const raw = await kvStore.get(`flags:${repo.name}`);
    if (!raw) continue;
    try {
      const inventory = JSON.parse(raw) as FlagInventory;
      for (const flag of inventory.flags) {
        let repoSet = flagsByName.get(flag.name);
        if (!repoSet) {
          repoSet = new Set();
          flagsByName.set(flag.name, repoSet);
        }
        repoSet.add(repo.name);
      }
    } catch { /* skip malformed */ }
  }

  // 2. Filter to flags in 2+ repos, check coordination
  const sharedFlags: Array<{ name: string; repos: string[]; coordinated: boolean }> = [];
  const sarifResults: SarifResult[] = [];

  for (const [flagName, repoSet] of flagsByName) {
    if (repoSet.size < 2) continue;

    const flagRepos = [...repoSet].sort();

    // Check coordination: is there a dependency edge between any pair?
    let coordinated = false;
    for (let i = 0; i < flagRepos.length && !coordinated; i++) {
      for (let j = i + 1; j < flagRepos.length && !coordinated; j++) {
        const pair1 = `${flagRepos[i]}->${flagRepos[j]}`;
        const pair2 = `${flagRepos[j]}->${flagRepos[i]}`;
        if (graph.repoPairs.has(pair1) || graph.repoPairs.has(pair2)) {
          coordinated = true;
        }
      }
    }

    sharedFlags.push({ name: flagName, repos: flagRepos, coordinated });

    // SARIF: shared-flag (note) for all shared flags
    const location = {
      logicalLocations: [
        createLogicalLocation(flagRepos[0]!, flagName, undefined, "feature-flag"),
      ],
    };
    const relatedLocations = flagRepos.slice(1).map((repo) => ({
      logicalLocations: [
        createLogicalLocation(repo, flagName, undefined, "feature-flag"),
      ],
    }));

    sarifResults.push(
      createSarifResult(
        "cross-repo/shared-flag",
        "note",
        `Feature flag "${flagName}" is used in ${flagRepos.length} repos: ${flagRepos.join(", ")}.`,
        {
          locations: [location],
          relatedLocations,
          properties: { repos: flagRepos, coordinated },
        },
      ),
    );

    // SARIF: uncoordinated-flag (warning) if not coordinated
    if (!coordinated) {
      sarifResults.push(
        createSarifResult(
          "cross-repo/uncoordinated-flag",
          "warning",
          `Feature flag "${flagName}" is shared across ${flagRepos.length} repos (${flagRepos.join(", ")}) but none have a dependency edge. Flag changes may not propagate correctly.`,
          {
            locations: [location],
            relatedLocations,
            properties: { repos: flagRepos },
          },
        ),
      );
    }
  }

  return { sharedFlags, sarifResults };
}
