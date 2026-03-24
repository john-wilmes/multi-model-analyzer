export type {
  ResolvedCrossRepoEdge,
  CrossRepoGraph,
  CrossRepoImpactResult,
  DependencyPath,
  ServiceLink,
  LinchpinService,
  PackageLinchpin,
  ServiceCorrelationResult,
  OrphanedService,
  CorrelationOptions,
  CorrelationResult,
  SharedFlag,
  CrossRepoFeatureResult,
  CrossRepoFaultLink,
  CrossRepoFaultResult,
  SystemCatalogEntry,
  SystemCatalogResult,
  CrossRepoModelsOptions,
  CrossRepoModelsResult,
  RepoState,
  RepoStatus,
  DiscoverySource,
} from "./types.js";

export { RepoStateManager } from "./repo-state.js";

export { buildCrossRepoGraph } from "./graph-builder.js";
export { computeCrossRepoImpact } from "./impact-analysis.js";
export { findDependencyPaths } from "./path-discovery.js";
export { buildServiceCorrelation } from "./service-correlation.js";
export {
  detectBreakingChangeRisk,
  detectOrphanedServices,
  detectCriticalPaths,
} from "./sarif-rules.js";
export { runCorrelation } from "./run-correlation.js";
export { detectCrossRepoFeatures } from "./cross-repo-features.js";
export { detectCrossRepoFaults } from "./cross-repo-faults.js";
export { buildSystemCatalog } from "./cross-repo-catalog.js";
export { runCrossRepoModels } from "./run-cross-repo-models.js";
export { discoverConnections, extractPackageName } from "./connection-discovery.js";
export type { RepoConnection, ConnectionDiscoveryOptions } from "./connection-discovery.js";
export { buildExportIndex, resolveSymbolsOnEdges } from "./symbol-resolver.js";
export type { ResolvedImportedSymbol } from "./types.js";
