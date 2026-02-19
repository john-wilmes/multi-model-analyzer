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
