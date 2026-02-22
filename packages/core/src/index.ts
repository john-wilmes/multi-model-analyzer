export type {
  // Repository & Ingestion
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
