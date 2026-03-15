export type {
  ResolvedCrossRepoEdge,
  CrossRepoGraph,
  CrossRepoImpactResult,
  DependencyPath,
  ServiceLink,
  LinchpinService,
  ServiceCorrelationResult,
  OrphanedService,
  CorrelationOptions,
  CorrelationResult,
} from "./types.js";

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
