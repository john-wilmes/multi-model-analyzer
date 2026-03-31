export type {
  // Repository & Ingestion
  CustomQueueFramework,
  ConfigScopeRule,
  RepoConfig,
  ChangeSet,
  FileKind,
  ClassifiedFile,

  // Parsing
  ParsedFile,
  SymbolInfo,
  SymbolKind,
  ParseError,

  // Structural
  GraphEdge,
  EdgeKind,
  CallGraph,
  DependencyGraph,
  ControlFlowNode,
  CfgNodeKind,
  ControlFlowGraph,
  CfgEdge,

  // Heuristics
  InferredService,
  InferredArchitecture,
  DetectedPattern,
  PatternKind,
  FeatureFlag,
  FlagInventory,
  ConfigParameter,
  ConfigParameterKind,
  ConfigValueType,
  ConfigInventory,
  LogTemplate,
  LogSeverity,
  LogTemplateIndex,
  MethodPurpose,
  MethodPurposeMap,

  // Summarization
  SummaryTier,
  Summary,
  SummaryIndex,

  // Analysis Models
  FaultTree,
  FaultTreeNode,
  FaultNodeKind,
  FeatureModel,
  FeatureConstraint,
  ConstraintKind,
  ServiceCatalogEntry,
  ApiEndpoint,

  // Metrics
  MetricZone,
  ModuleMetrics,
  RepoMetricsSummary,

  // Architectural Rules
  ArchitecturalRule,
  LayerRuleConfig,
  ForbiddenImportConfig,
  DependencyDirectionConfig,

  // Shared
  LogicalLocation,
  ContentHash,
  IndexState,

  // Heuristic scoring
  HeuristicMeta,
  HeuristicResult,
} from "./types.js";

export type {
  // SARIF types
  SarifLog,
  SarifRun,
  SarifTool,
  SarifToolComponent,
  SarifReportingDescriptor,
  SarifReportingConfiguration,
  SarifLevel,
  SarifMultiformatMessage,
  SarifResult,
  SarifLocation,
  SarifLogicalLocation,
  SarifCodeFlow,
  SarifThreadFlow,
  SarifThreadFlowLocation,
  SarifBaselineState,
  SarifRunProperties,
  SarifStatistics,
} from "./sarif.js";

export {
  createSarifLog,
  createSarifRun,
  createSarifResult,
  createLogicalLocation,
} from "./sarif.js";

export type {
  // Hypothesis types
  HypothesisSource,
  HypothesisProvider,
  ReflexionResult,
  ReflexionEngine,
  ArchitectureHypothesis,
  ExpectedService,
  ServiceBoundary,
  ConfigConstraintHypothesis,
  HazardPriorityHypothesis,
  HazardEntry,
} from "./hypothesis.js";

export {
  HeuristicArchitectureProvider,
  ArchitectureReflexionEngine,
  HeuristicConfigConstraintProvider,
  HeuristicHazardPriorityProvider,
} from "./hypothesis.js";

export type { PhaseResult } from "./tracer.js";
export { traceSync, traceAsync, runHeuristic } from "./tracer.js";

export { classifyFileKind } from "./classify.js";

export type { ParsedSymbolId } from "./symbol-id.js";
export {
  makeSymbolId,
  makeFileId,
  parseSymbolId,
  extractRepo,
  canonicalize,
} from "./symbol-id.js";
