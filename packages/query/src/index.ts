export { routeQuery } from "./router.js";
export type { RouterConfig, RouteDecision, QueryRoute } from "./router.js";

export { executeCallersQuery, executeCalleesQuery, executeDependencyQuery } from "./structural.js";
export type { StructuralQueryResult } from "./structural.js";

export { executeSearchQuery } from "./search.js";
export type { SearchQueryResult } from "./search.js";

export { executeArchitectureQuery } from "./architecture.js";
export type { ArchitectureQueryResult, RepoSummary, CrossRepoEdge, ServiceLink } from "./architecture.js";

export { computeBlastRadius } from "./blast-radius.js";
export type { BlastRadiusResult, AffectedFile } from "./blast-radius.js";
