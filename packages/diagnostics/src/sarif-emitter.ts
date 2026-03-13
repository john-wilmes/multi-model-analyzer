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

  constructor(options: EmitterOptions) {
    this.options = options;
  }

  emit(result: SarifResult): void {
    this.results.push(result);
  }

  emitAll(results: readonly SarifResult[]): void {
    this.results.push(...results);
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
