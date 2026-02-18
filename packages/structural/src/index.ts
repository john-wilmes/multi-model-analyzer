export {
  extractCallGraph,
  findCallers,
  findCallees,
  getTransitiveDependencies,
} from "./callgraph.js";
export type { CallGraphOptions } from "./callgraph.js";

export {
  extractDependencyGraph,
  findDependentsOf,
  findDependenciesOf,
} from "./dependencies.js";
export type { DependencyGraphOptions } from "./dependencies.js";

export {
  buildControlFlowGraph,
  traceBackward,
  resetNodeIdCounter,
} from "./cfg.js";

export {
  generateScipIndex,
  parseScipSymbolString,
} from "./scip.js";
export type { ScipIndexResult, ScipSymbol, ScipRelationship } from "./scip.js";
