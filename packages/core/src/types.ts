/**
 * Core types for the multi-model analyzer.
 *
 * These types are shared across all packages and define the fundamental
 * data structures flowing through the analysis pipeline.
 */

// -- Repository & Ingestion --

export interface RepoConfig {
  readonly name: string;
  readonly url: string;
  readonly branch: string;
  readonly localPath: string;
}

export interface ChangeSet {
  readonly repo: string;
  readonly commitHash: string;
  readonly previousCommitHash: string | null;
  readonly addedFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
  readonly timestamp: Date;
}

export type FileKind =
  | "typescript"
  | "javascript"
  | "json"
  | "yaml"
  | "dockerfile"
  | "kubernetes"
  | "markdown"
  | "unknown";

export interface ClassifiedFile {
  readonly path: string;
  readonly repo: string;
  readonly kind: FileKind;
  readonly relativePath: string;
}

// -- Parsing --

export interface ParsedFile {
  readonly path: string;
  readonly repo: string;
  readonly kind: FileKind;
  readonly symbols: readonly SymbolInfo[];
  readonly errors: readonly ParseError[];
  readonly contentHash: string;
}

export interface SymbolInfo {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly exported: boolean;
  readonly containerName?: string;
}

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "enum"
  | "method"
  | "property"
  | "namespace";

export interface ParseError {
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly filePath: string;
}

// -- Structural Analysis --

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly kind: EdgeKind;
  readonly metadata?: Record<string, unknown>;
}

export type EdgeKind =
  | "calls"
  | "imports"
  | "extends"
  | "implements"
  | "depends-on"
  | "contains";

export interface CallGraph {
  readonly repo: string;
  readonly edges: readonly GraphEdge[];
  readonly nodeCount: number;
}

export interface DependencyGraph {
  readonly repo: string;
  readonly edges: readonly GraphEdge[];
  readonly circularDependencies: readonly string[][];
}

export interface ControlFlowNode {
  readonly id: string;
  readonly kind: CfgNodeKind;
  readonly label: string;
  readonly location: LogicalLocation;
}

export type CfgNodeKind =
  | "entry"
  | "exit"
  | "statement"
  | "branch"
  | "loop"
  | "try"
  | "catch"
  | "throw"
  | "return";

export interface ControlFlowGraph {
  readonly functionId: string;
  readonly nodes: readonly ControlFlowNode[];
  readonly edges: readonly CfgEdge[];
}

export interface CfgEdge {
  readonly from: string;
  readonly to: string;
  readonly condition?: string;
}

// -- Heuristic Analysis --

export interface InferredService {
  readonly name: string;
  readonly rootPath: string;
  readonly entryPoints: readonly string[];
  readonly dependencies: readonly string[];
  readonly confidence: number;
}

export interface InferredArchitecture {
  readonly services: readonly InferredService[];
  readonly patterns: readonly DetectedPattern[];
  readonly repo: string;
}

export interface DetectedPattern {
  readonly name: string;
  readonly kind: PatternKind;
  readonly locations: readonly LogicalLocation[];
  readonly confidence: number;
}

export type PatternKind =
  | "adapter"
  | "facade"
  | "observer"
  | "factory"
  | "singleton"
  | "repository"
  | "middleware"
  | "decorator";

export interface FeatureFlag {
  readonly name: string;
  readonly locations: readonly LogicalLocation[];
  readonly sdk?: string;
  readonly defaultValue?: unknown;
}

export interface FlagInventory {
  readonly repo: string;
  readonly flags: readonly FeatureFlag[];
}

export interface LogTemplate {
  readonly id: string;
  readonly template: string;
  readonly severity: LogSeverity;
  readonly locations: readonly LogicalLocation[];
  readonly frequency: number;
}

export type LogSeverity = "error" | "warn" | "info" | "debug";

export interface LogTemplateIndex {
  readonly repo: string;
  readonly templates: readonly LogTemplate[];
}

export interface MethodPurpose {
  readonly methodId: string;
  readonly verb: string;
  readonly object: string;
  readonly purpose: string;
  readonly confidence: number;
}

export interface MethodPurposeMap {
  readonly repo: string;
  readonly methods: readonly MethodPurpose[];
}

// -- Summarization --

export type SummaryTier = 1 | 2 | 3 | 4;

export interface Summary {
  readonly entityId: string;
  readonly tier: SummaryTier;
  readonly description: string;
  readonly confidence: number;
}

export interface SummaryIndex {
  readonly entries: ReadonlyMap<string, Summary>;
}

// -- Analysis Models --

export interface FaultTree {
  readonly topEvent: FaultTreeNode;
  readonly repo: string;
}

export interface FaultTreeNode {
  readonly id: string;
  readonly label: string;
  readonly kind: FaultNodeKind;
  readonly location?: LogicalLocation;
  readonly children: readonly FaultTreeNode[];
}

export type FaultNodeKind =
  | "top-event"
  | "and-gate"
  | "or-gate"
  | "basic-event"
  | "undeveloped";

export interface FeatureModel {
  readonly flags: readonly FeatureFlag[];
  readonly constraints: readonly FeatureConstraint[];
}

export interface FeatureConstraint {
  readonly kind: ConstraintKind;
  readonly flags: readonly string[];
  readonly description: string;
  readonly source: "inferred" | "human";
}

export type ConstraintKind =
  | "requires"
  | "excludes"
  | "implies"
  | "mutex"
  | "range";

export interface ServiceCatalogEntry {
  readonly name: string;
  readonly purpose: string;
  readonly dependencies: readonly string[];
  readonly apiSurface: readonly ApiEndpoint[];
  readonly errorHandlingSummary: string;
}

export interface ApiEndpoint {
  readonly method: string;
  readonly path: string;
  readonly description: string;
}

// -- Shared --

export interface LogicalLocation {
  readonly repo: string;
  readonly module: string;
  readonly fullyQualifiedName?: string;
  readonly kind?: string;
}

export interface ContentHash {
  readonly hash: string;
  readonly algorithm: "sha256";
}

export interface IndexState {
  readonly repo: string;
  readonly commitHash: string;
  readonly indexedAt: Date;
  readonly fileCount: number;
}
