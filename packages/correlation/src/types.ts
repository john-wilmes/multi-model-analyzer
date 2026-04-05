/**
 * Types for cross-repo correlation analysis.
 */

import type { GraphEdge, RepoConfig, SarifResult, ServiceCatalogEntry } from "@mma/core";

/** A symbol imported from another repo, resolved to its definition. */
export interface ResolvedImportedSymbol {
  /** Imported name (e.g. "createClient", "default", "*"). */
  readonly name: string;
  /** Canonical file ID where the symbol is actually defined (repo:path). */
  readonly targetFileId: string;
  /** SymbolKind from the export (function, class, type, etc.). */
  readonly kind: string;
}

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

/** A linchpin package — imported by multiple repos. */
export interface PackageLinchpin {
  readonly packageName: string;
  /** Repo that owns/publishes this package. */
  readonly ownerRepo: string;
  /** Number of distinct repos that import this package (excludes the owner since only cross-repo edges are considered). Equals importingRepos.length. */
  readonly importerCount: number;
  /** Names of repos that import this package (excludes the owner). */
  readonly importingRepos: readonly string[];
  /** Total number of cross-repo import edges for this package. */
  readonly edgeCount: number;
  /** Score: importerCount * edgeCount — higher = more critical. */
  readonly criticalityScore: number;
}

/** Service correlation results. */
export interface ServiceCorrelationResult {
  readonly links: readonly ServiceLink[];
  readonly linchpins: readonly LinchpinService[];
  readonly packageLinchpins: readonly PackageLinchpin[];
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

// -- Cross-Repo Model Types --

/** A feature flag shared across 2+ repos. */
export interface SharedFlag {
  readonly name: string;
  readonly repos: readonly string[];
  /** Whether repos sharing this flag have a dependency edge between them. */
  readonly coordinated: boolean;
}

/** Result of cross-repo feature flag coordination analysis. */
export interface CrossRepoFeatureResult {
  readonly sharedFlags: readonly SharedFlag[];
  readonly sarifResults: readonly SarifResult[];
}

/** A fault propagation link between two repos connected by a service link. */
export interface CrossRepoFaultLink {
  readonly endpoint: string;
  readonly sourceRepo: string;
  readonly targetRepo: string;
  readonly sourceFaultTreeCount: number;
  readonly targetFaultTreeCount: number;
}

/** Result of cross-repo fault propagation analysis. */
export interface CrossRepoFaultResult {
  readonly faultLinks: readonly CrossRepoFaultLink[];
  readonly sarifResults: readonly SarifResult[];
}

/** A service catalog entry enriched with cross-repo consumer/producer info. */
export interface SystemCatalogEntry {
  readonly entry: ServiceCatalogEntry;
  readonly repo: string;
  readonly consumers: readonly string[];
  readonly producers: readonly string[];
}

/** Result of system-wide service catalog merge. */
export interface SystemCatalogResult {
  readonly entries: readonly SystemCatalogEntry[];
  readonly sarifResults: readonly SarifResult[];
}

/** Options for cross-repo model analysis. */
export interface CrossRepoModelsOptions {
  readonly repos: readonly RepoConfig[];
  readonly crossRepoGraph: CrossRepoGraph;
  readonly serviceCorrelation: ServiceCorrelationResult;
  readonly verbose?: boolean;
}

/** Status of a repo in the incremental indexing workflow. */
export type RepoStatus = "candidate" | "indexing" | "indexed" | "ignored";

/** How a repo was discovered for indexing. */
export type DiscoverySource =
  | "org-scan"
  | `dependency:${string}`
  | "user-selected"
  | `reverse-dep:${string}`;

/** Persisted state for a single repo in the incremental indexing workflow. */
export interface RepoState {
  readonly name: string;
  readonly url: string;
  readonly defaultBranch?: string;
  readonly language?: string;
  readonly status: RepoStatus;
  readonly discoveredVia: DiscoverySource;
  readonly discoveredAt: string; // ISO date
  readonly indexedAt?: string; // ISO date
  readonly ignoredAt?: string; // ISO date
  /** Number of cross-repo connections (edges) to/from already-indexed repos. */
  readonly connectionCount: number;
}

/** Combined result of all cross-repo model analyses. */
export interface CrossRepoModelsResult {
  readonly features: CrossRepoFeatureResult;
  readonly faults: CrossRepoFaultResult;
  readonly catalog: SystemCatalogResult;
  readonly sarifResults: readonly SarifResult[];
  readonly counts: {
    readonly sharedFlags: number;
    readonly faultLinks: number;
    readonly catalogEntries: number;
    readonly sarifFindings: number;
  };
}
