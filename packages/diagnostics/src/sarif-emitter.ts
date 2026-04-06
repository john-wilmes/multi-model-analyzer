/**
 * SARIF emitter for individual analysis components.
 *
 * Each component registers its rules and emits results through this interface.
 * Results use logicalLocations only (no physical locations, no source snippets).
 */

import type {
  SarifLog,
  SarifRun,
  SarifResult,
  SarifReportingDescriptor,
  SarifRunProperties,
  SarifStatistics,
} from "@mma/core";
import { createSarifLog, createSarifRun } from "@mma/core";

export interface EmitterOptions {
  readonly toolName: string;
  readonly toolVersion: string;
  readonly rules: readonly SarifReportingDescriptor[];
}

export class SarifEmitter {
  private results: SarifResult[] = [];
  private readonly options: EmitterOptions;
  private readonly knownRuleIds: ReadonlySet<string>;
  private readonly warnedRuleIds = new Set<string>();

  constructor(options: EmitterOptions) {
    this.options = options;
    this.knownRuleIds = new Set(options.rules.map((r) => r.id));
  }

  emit(result: SarifResult): void {
    this.validateRuleId(result.ruleId);
    this.results.push(result);
  }

  emitAll(results: readonly SarifResult[]): void {
    for (const result of results) {
      this.validateRuleId(result.ruleId);
    }
    this.results.push(...results);
  }

  private validateRuleId(ruleId: string): void {
    if (!this.knownRuleIds.has(ruleId) && !this.warnedRuleIds.has(ruleId)) {
      this.warnedRuleIds.add(ruleId);
      console.warn(
        `[SarifEmitter] Unknown ruleId "${ruleId}" has no matching rule in tool "${this.options.toolName}". ` +
          `Known rules: ${[...this.knownRuleIds].join(", ") || "(none)"}`,
      );
    }
  }

  toRun(properties?: Record<string, unknown>): SarifRun {
    const stats = this.computeStatistics();
    const runProps: SarifRunProperties = {
      statistics: stats,
      ...properties,
    };

    return createSarifRun(
      this.options.toolName,
      this.options.toolVersion,
      this.options.rules,
      this.results,
      { properties: runProps },
    );
  }

  toLog(properties?: Record<string, unknown>): SarifLog {
    return createSarifLog([this.toRun(properties)]);
  }

  getResultCount(): number {
    return this.results.length;
  }

  getResults(): readonly SarifResult[] {
    return this.results;
  }

  clear(): void {
    this.results = [];
  }

  private computeStatistics(): SarifStatistics {
    let errorCount = 0;
    let warningCount = 0;
    let noteCount = 0;
    const rulesTriggered = new Set<string>();

    for (const result of this.results) {
      rulesTriggered.add(result.ruleId);
      switch (result.level) {
        case "error":
          errorCount++;
          break;
        case "warning":
          warningCount++;
          break;
        case "note":
          noteCount++;
          break;
      }
    }

    return {
      totalResults: this.results.length,
      errorCount,
      warningCount,
      noteCount,
      rulesTriggered: rulesTriggered.size,
      analysisTimestamp: new Date().toISOString(),
    };
  }
}
