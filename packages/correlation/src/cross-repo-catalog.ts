/**
 * System-wide service catalog builder.
 *
 * Merges per-repo service catalogs with cross-repo consumer/producer info
 * from service correlation to produce a unified system catalog.
 */

import type { KVStore } from "@mma/storage";
import type { RepoConfig, ServiceCatalogEntry, SarifResult } from "@mma/core";
import { createSarifResult, createLogicalLocation } from "@mma/core";
import type {
  CrossRepoGraph,
  ServiceCorrelationResult,
  SystemCatalogEntry,
  SystemCatalogResult,
} from "./types.js";

export async function buildSystemCatalog(
  kvStore: KVStore,
  repos: readonly RepoConfig[],
  _graph: CrossRepoGraph,
  serviceCorrelation: ServiceCorrelationResult,
): Promise<SystemCatalogResult> {
  // 1. Load catalog:<repo> from KV -> flat lookup
  const allEntries: SystemCatalogEntry[] = [];
  const catalogByService = new Map<string, { entry: ServiceCatalogEntry; repo: string }>();

  for (const repo of repos) {
    const raw = await kvStore.get(`catalog:${repo.name}`);
    if (!raw) continue;
    try {
      const catalog = JSON.parse(raw) as ServiceCatalogEntry[];
      for (const entry of catalog) {
        catalogByService.set(`${repo.name}::${entry.name}`, { entry, repo: repo.name });
      }
    } catch { /* skip malformed */ }
  }

  // 2. Build consumer/producer info from service links
  // Map service name -> { consumers: Set<repo>, producers: Set<repo> }
  const serviceInfo = new Map<string, { consumers: Set<string>; producers: Set<string> }>();

  for (const link of serviceCorrelation.links) {
    let info = serviceInfo.get(link.endpoint);
    if (!info) {
      info = { consumers: new Set(), producers: new Set() };
      serviceInfo.set(link.endpoint, info);
    }
    for (const repo of link.producers.keys()) {
      info.producers.add(repo);
    }
    for (const repo of link.consumers.keys()) {
      info.consumers.add(repo);
    }
  }

  // 3. Merge catalog entries with service link info
  for (const [, { entry, repo }] of catalogByService) {
    const info = serviceInfo.get(entry.name);
    allEntries.push({
      entry,
      repo,
      consumers: info ? [...info.consumers].sort() : [],
      producers: info ? [...info.producers].sort() : [],
    });
  }

  // 4. SARIF: detect undocumented consumers
  const sarifResults: SarifResult[] = [];

  for (const link of serviceCorrelation.links) {
    for (const consumerRepo of link.consumers.keys()) {
      // Check if consumer repo has this endpoint documented in its catalog
      const hasDocumented = catalogByService.has(`${consumerRepo}::${link.endpoint}`);
      // Also check if the producer has it documented
      const producerHasIt = [...link.producers.keys()].some(
        (pRepo) => catalogByService.has(`${pRepo}::${link.endpoint}`),
      );

      // If neither the consumer nor any producer documents this service, flag it
      if (!hasDocumented && !producerHasIt) {
        const location = {
          logicalLocations: [
            createLogicalLocation(consumerRepo, link.endpoint, undefined, "service"),
          ],
        };

        sarifResults.push(
          createSarifResult(
            "cross-repo/undocumented-consumer",
            "note",
            `Repo "${consumerRepo}" consumes service "${link.endpoint}" but it is not documented in any repo's service catalog.`,
            {
              locations: [location],
              properties: { consumerRepo, endpoint: link.endpoint },
            },
          ),
        );
      }
    }
  }

  return { entries: allEntries, sarifResults };
}
