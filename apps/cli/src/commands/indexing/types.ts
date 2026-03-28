/**
 * Shared types for the indexing pipeline phase modules.
 */

import type {
  RepoConfig,
  ChangeSet,
  DependencyGraph,
  ParsedFile,
  InferredService,
  DetectedPattern,
  FlagInventory,
  ConfigInventory,
  LogTemplateIndex,
  MethodPurposeMap,
} from "@mma/core";
import type { KVStore, GraphStore, SearchStore } from "@mma/storage";
import type { ArchitecturalRule } from "@mma/core";
import type { AffectedScope } from "../affected-scope.js";
import type { Advisory } from "@mma/heuristics";
import type { classifyFiles } from "@mma/ingestion";

export interface IndexOptions {
  readonly repos: readonly RepoConfig[];
  readonly mirrorDir: string;
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly verbose: boolean;
  readonly enableTsMorph?: boolean;
  readonly maxApiCalls?: number;
  readonly rules?: readonly ArchitecturalRule[];
  readonly affected?: boolean;
  readonly forceFullReindex?: boolean;
  readonly advisories?: readonly Advisory[];
  readonly enrich?: boolean;
  readonly ollamaUrl?: string;
  readonly ollamaModel?: string;
  readonly llmProvider?: "anthropic" | "openai" | "ollama";
  readonly llmApiKey?: string;
  readonly llmModel?: string;
}

export interface IndexResult {
  readonly hadChanges: boolean;
  readonly repoCount: number;
  readonly totalFiles: number;
  readonly totalSarifResults: number;
  readonly failedRepos: number;
  /** Names of repos that failed at any pipeline phase. */
  readonly failedRepoNames: ReadonlySet<string>;
}

/** Shared API budget across all parallel workers. */
export interface ApiBudget {
  remaining: number;
  reserve(n: number): number;
  refund(n: number): void;
}

/**
 * Pipeline context — shared mutable state passed to all phase functions.
 * Each phase reads and/or writes into these maps.
 */
export interface PipelineContext {
  readonly options: IndexOptions;
  readonly log: (...args: unknown[]) => void;
  readonly mirrorDir: string;
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly repos: readonly RepoConfig[];

  /** Populated by Phase 1 (ingestion). */
  readonly changeSets: ChangeSet[];

  /** Populated before Phase 3. */
  readonly previousCommits: Map<string, string>;

  /** Populated by Phase 2 (classify). */
  readonly classifiedByRepo: Map<string, ReturnType<typeof classifyFiles>>;

  /** Populated by Phase 2 (classify). */
  readonly packageRoots: Map<string, string>;

  /** Optionally populated before Phase 3 (affected scoping). */
  scopeByRepo: Map<string, AffectedScope> | undefined;

  /** Populated by Phase 3 (parsing). Deleted after per-repo completion to free memory. */
  readonly parsedFilesByRepo: Map<string, ParsedFile[]>;

  /** Populated by Phase 4a (dep graph). Deleted after per-repo completion. */
  readonly depGraphByRepo: Map<string, DependencyGraph>;

  /** Populated by Phase 5 (heuristics). Deleted after per-repo completion. */
  readonly servicesByRepo: Map<string, InferredService[]>;

  /** Populated by Phase 5 (heuristics). Deleted after per-repo completion. */
  readonly patternsByRepo: Map<string, DetectedPattern[]>;

  /** Populated by Phase 5 (heuristics). Deleted after per-repo completion. */
  readonly flagsByRepo: Map<string, FlagInventory>;

  /** Populated by Phase 5 (heuristics). Deleted after per-repo completion. */
  readonly settingsByRepo: Map<string, ConfigInventory>;

  /** Populated by Phase 5 (heuristics). Deleted after per-repo completion. */
  readonly logIndexByRepo: Map<string, LogTemplateIndex>;

  /** Populated by Phase 5 (heuristics). Deleted after per-repo completion. */
  readonly namingByRepo: Map<string, MethodPurposeMap>;

  /**
   * Per-repo tree-sitter trees, stored here during runPhaseParsing/runPhaseStructural
   * and consumed + deleted in runPhaseModels (last consumer).
   */
  readonly treesByRepo: Map<string, ReadonlyMap<string, import("@mma/parsing").TreeSitterTree>>;

  /** Repos that entered recovery mode (reloaded symbols from KV). */
  readonly recoveryRepos: Set<string>;

  /** Repos that completed all phases successfully. */
  readonly completedRepos: Set<string>;

  /** Repos that failed at any pipeline phase. */
  readonly failedRepoNames: Set<string>;

  /** Accumulated by Phase 6b (summarization). */
  phase6bTotalMs: number;

  /** Accumulated by Phase 6c (functional model). */
  phase6cTotalMs: number;

  /** Accumulated across Phase 3-6c. */
  totalFiles: number;

  /** Shared API budget — undefined when maxApiCalls is not set. */
  readonly sharedApiBudget: ApiBudget | undefined;
}
