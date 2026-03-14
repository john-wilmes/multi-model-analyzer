export {
  extractCallGraph,
  extractCallEdgesFromTreeSitter,
  findCallers,
  findCallees,
  getTransitiveDependencies,
} from "./callgraph.js";
export type { CallGraphOptions, TsNode } from "./callgraph.js";

export {
  extractDependencyGraph,
  findCircularDependencies,
  findDependentsOf,
  findDependenciesOf,
  resolveImportSpecifier,
} from "./dependencies.js";
export type { DependencyGraphOptions } from "./dependencies.js";

export {
  buildControlFlowGraph,
  traceBackward,
  createCfgIdCounter,
} from "./cfg.js";
export type { CfgIdCounter } from "./cfg.js";

export {
  generateScipIndex,
  parseScipSymbolString,
} from "./scip.js";
export type { ScipIndexResult, ScipSymbol, ScipRelationship } from "./scip.js";

export { computeModuleMetrics, summarizeRepoMetrics, detectInstabilityViolations } from "./metrics.js";

export { detectDeadExports } from "./dead-exports.js";
export type { DeadExportOptions } from "./dead-exports.js";
