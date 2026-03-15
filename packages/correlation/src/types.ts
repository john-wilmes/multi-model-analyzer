/**
 * Types for cross-repo correlation analysis.
 */

import type { GraphEdge, RepoConfig, SarifResult } from "@mma/core";

/** A cross-repo edge with resolved source and target repos. */
export interface ResolvedCrossRepoEdge {
  readonly edge: GraphEdge;
  readonly sourceRepo: string;
  readonly targetRepo: string;
  readonly packageName: string;
}

/** Graph of cross-repo dependencies. */
export interface CrossRepoGraph {
  readonly edges: readonly ResolvedCrossRepoEdge[];
  /** Set of unique "sourceRepo->targetRepo" pairs. */
  readonly repoPairs: ReadonlySet<string>;
  /** repo -> set of repos it depends on (downstream). */
  readonly downstreamMap: ReadonlyMap<string, ReadonlySet<string>>;
  /** repo -> set of repos that depend on it (upstream). */
  readonly upstreamMap: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Result of cross-repo impact analysis. */
export interface CrossRepoImpactResult {
  readonly changedFiles: readonly string[];
  readonly changedRepo: string;
  /** Files affected within the changed repo (transitive). */
  readonly affectedWithinRepo: readonly string[];
  /** Files affected in other repos (cross-boundary). */
  readonly affectedAcrossRepos: ReadonlyMap<string, readonly string[]>;
  /** Total repos reached (including the changed repo). */
  readonly reposReached: number;
}

/** A dependency path between repos. */
export interface DependencyPath {
  /** Ordered repo names from source to target. */
  readonly nodes: readonly string[];
  /** Number of boundary crossings (always nodes.length - 1). */
  readonly boundaryCount: number;
}

/** A linked service endpoint with producer/consumer info. */
export interface ServiceLink {
  readonly endpoint: string;
  readonly producers: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly consumers: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly linkedRepos: ReadonlySet<string>;
}

/** A linchpin service — high cross-repo coupling. */
export interface LinchpinService {
  readonly endpoint: string;
  readonly producerCount: number;
  readonly consumerCount: number;
  readonly linkedRepoCount: number;
  /** Score: (producers + consumers) * linkedRepos. */
  readonly criticalityScore: number;
}

/** Service correlation results. */
export interface ServiceCorrelationResult {
  readonly links: readonly ServiceLink[];
  readonly linchpins: readonly LinchpinService[];
  readonly orphanedServices: readonly OrphanedService[];
}

/** A service with producers but no cross-repo consumers (or vice versa). */
export interface OrphanedService {
  readonly endpoint: string;
  readonly hasProducers: boolean;
  readonly hasConsumers: boolean;
  readonly repos: readonly string[];
}

/** Options for correlation analysis. */
export interface CorrelationOptions {
  readonly repos: readonly RepoConfig[];
  readonly packageRoots: ReadonlyMap<string, string>;
  readonly verbose?: boolean;
}

/** Complete correlation result. */
export interface CorrelationResult {
  readonly crossRepoGraph: CrossRepoGraph;
  readonly serviceCorrelation: ServiceCorrelationResult;
  readonly sarifResults: readonly SarifResult[];
  readonly counts: {
    readonly crossRepoEdges: number;
    readonly repoPairs: number;
    readonly linchpins: number;
    readonly orphanedServices: number;
    readonly sarifFindings: number;
  };
}
