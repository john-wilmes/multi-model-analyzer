/**
 * Service correlation analysis.
 *
 * Discovers cross-repo service relationships by analyzing service-call edges.
 * Identifies linchpin services (high cross-repo coupling) and orphaned services
 * (producers with no cross-repo consumers, or vice versa).
 */

import type { GraphEdge, RepoConfig } from "@mma/core";
import type { GraphStore } from "@mma/storage";
import type {
  ServiceCorrelationResult,
  ServiceLink,
  LinchpinService,
  OrphanedService,
} from "./types.js";

/**
 * Extract the repo name from an edge's metadata, falling back to matching
 * against known repo localPaths via the edge source prefix.
 */
function resolveRepo(edge: GraphEdge, repos: readonly RepoConfig[]): string | undefined {
  const metaRepo = edge.metadata?.["repo"];
  if (typeof metaRepo === "string" && metaRepo.length > 0) {
    return metaRepo;
  }
  // Fall back to matching edge.source prefix against repo localPaths
  for (const repo of repos) {
    if (edge.source.startsWith(repo.localPath)) {
      return repo.name;
    }
  }
  return undefined;
}

/**
 * Build service correlation from service-call edges across all repos.
 *
 * Algorithm:
 * 1. Load all service-call edges for each repo
 * 2. Group by edge.target (the endpoint/queue name)
 * 3. For each endpoint, classify edges as producer or consumer per repo
 * 4. Detect linchpins: endpoints spanning >= 2 repos with combined usage >= 2
 * 5. Detect orphaned services: producers with no cross-repo consumers (or vice versa)
 */
export async function buildServiceCorrelation(
  graphStore: GraphStore,
  repos: readonly RepoConfig[],
): Promise<ServiceCorrelationResult> {
  // Collect all service-call edges.
  // Load per-repo first (metadata.repo filter) to get known edges, then load
  // the full set to catch edges whose repo must be resolved via localPath prefix.
  const seenSources = new Set<string>();
  const allEdges: GraphEdge[] = [];

  for (const repo of repos) {
    const edges = await graphStore.getEdgesByKind("service-call", repo.name);
    for (const e of edges) {
      seenSources.add(e.source + "\0" + e.target);
      allEdges.push(e);
    }
  }

  // Also load without repo filter to catch edges without metadata.repo set
  const allUnfiltered = await graphStore.getEdgesByKind("service-call");
  for (const e of allUnfiltered) {
    const key = e.source + "\0" + e.target;
    if (!seenSources.has(key)) {
      allEdges.push(e);
    }
  }

  // Group edges by endpoint (edge.target)
  const byEndpoint = new Map<string, GraphEdge[]>();
  for (const edge of allEdges) {
    const endpoint = edge.target;
    if (!byEndpoint.has(endpoint)) {
      byEndpoint.set(endpoint, []);
    }
    byEndpoint.get(endpoint)!.push(edge);
  }

  // Build ServiceLinks
  const links: ServiceLink[] = [];
  for (const [endpoint, edges] of byEndpoint) {
    const producers = new Map<string, GraphEdge[]>();
    const consumers = new Map<string, GraphEdge[]>();
    const linkedRepos = new Set<string>();

    for (const edge of edges) {
      const repo = resolveRepo(edge, repos);
      if (!repo) continue;

      linkedRepos.add(repo);
      const role = edge.metadata?.["role"];

      if (role === "producer") {
        if (!producers.has(repo)) producers.set(repo, []);
        producers.get(repo)!.push(edge);
      } else {
        // Default to consumer for "consumer" role or unknown
        if (!consumers.has(repo)) consumers.set(repo, []);
        consumers.get(repo)!.push(edge);
      }
    }

    links.push({ endpoint, producers, consumers, linkedRepos });
  }

  // Detect linchpins: linkedRepos >= 2 AND (producers.size + consumers.size) >= 2
  const linchpins: LinchpinService[] = [];
  for (const link of links) {
    const producerCount = link.producers.size;
    const consumerCount = link.consumers.size;
    const linkedRepoCount = link.linkedRepos.size;

    if (linkedRepoCount >= 2 && (producerCount + consumerCount) >= 2) {
      linchpins.push({
        endpoint: link.endpoint,
        producerCount,
        consumerCount,
        linkedRepoCount,
        criticalityScore: (producerCount + consumerCount) * linkedRepoCount,
      });
    }
  }
  linchpins.sort((a, b) => b.criticalityScore - a.criticalityScore);

  // Detect orphaned services:
  // - Has producers in some repos but no consumers from OTHER repos
  // - Has consumers in some repos but no producers from ANY repo
  const orphanedServices: OrphanedService[] = [];
  for (const link of links) {
    const { endpoint, producers, consumers, linkedRepos } = link;
    const hasProducers = producers.size > 0;
    const hasConsumers = consumers.size > 0;

    // Cross-repo orphan: producers exist but consumers are only in the same repos as producers
    // (i.e., no consumers from repos that aren't also producers), or no consumers at all
    const producerRepos = new Set(producers.keys());
    const consumerRepos = new Set(consumers.keys());

    const hasExternalConsumers = [...consumerRepos].some((r) => !producerRepos.has(r));
    const hasExternalProducers = [...producerRepos].some((r) => !consumerRepos.has(r));

    const isOrphaned =
      (hasProducers && !hasConsumers) ||
      (hasConsumers && !hasProducers) ||
      (hasProducers && hasConsumers && !hasExternalConsumers) ||
      (hasProducers && hasConsumers && !hasExternalProducers);

    if (isOrphaned) {
      orphanedServices.push({
        endpoint,
        hasProducers,
        hasConsumers,
        repos: [...linkedRepos],
      });
    }
  }

  return { links, linchpins, orphanedServices };
}
