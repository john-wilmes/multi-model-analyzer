/**
 * Tests for SarifEmitter: result collection, statistics, and SARIF output.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { SarifResult, SarifReportingDescriptor } from "@mma/core";
import { SarifEmitter } from "./sarif-emitter.js";

const rules: SarifReportingDescriptor[] = [
  { id: "test/rule-1", shortDescription: { text: "Rule 1" } },
  { id: "test/rule-2", shortDescription: { text: "Rule 2" } },
];

function makeResult(ruleId: string, level: "error" | "warning" | "note", msg: string): SarifResult {
  return { ruleId, level, message: { text: msg } };
}

describe("SarifEmitter", () => {
  let emitter: SarifEmitter;

  beforeEach(() => {
    emitter = new SarifEmitter({
      toolName: "test-tool",
      toolVersion: "1.0.0",
      rules,
    });
  });

  it("starts with zero results", () => {
    expect(emitter.getResultCount()).toBe(0);
    expect(emitter.getResults()).toEqual([]);
  });

  it("emits individual results", () => {
    emitter.emit(makeResult("test/rule-1", "warning", "found issue"));

    expect(emitter.getResultCount()).toBe(1);
    expect(emitter.getResults()[0]!.ruleId).toBe("test/rule-1");
  });

  it("emits multiple results at once", () => {
    const results = [
      makeResult("test/rule-1", "error", "error 1"),
      makeResult("test/rule-2", "note", "note 1"),
    ];
    emitter.emitAll(results);

    expect(emitter.getResultCount()).toBe(2);
  });

  it("clears all results", () => {
    emitter.emit(makeResult("test/rule-1", "warning", "issue"));
    emitter.clear();

    expect(emitter.getResultCount()).toBe(0);
    expect(emitter.getResults()).toEqual([]);
  });

  it("produces a valid SARIF run with statistics", () => {
    emitter.emit(makeResult("test/rule-1", "error", "err"));
    emitter.emit(makeResult("test/rule-1", "warning", "warn"));
    emitter.emit(makeResult("test/rule-2", "note", "note"));

    const run = emitter.toRun();

    expect(run.tool.driver.name).toBe("test-tool");
    expect(run.tool.driver.version).toBe("1.0.0");
    expect(run.results).toHaveLength(3);

    const stats = run.properties?.statistics;
    expect(stats).toBeDefined();
    expect(stats!.totalResults).toBe(3);
    expect(stats!.errorCount).toBe(1);
    expect(stats!.warningCount).toBe(1);
    expect(stats!.noteCount).toBe(1);
    expect(stats!.rulesTriggered).toBe(2);
    expect(stats!.analysisTimestamp).toBeDefined();
  });

  it("produces a valid SARIF log", () => {
    emitter.emit(makeResult("test/rule-1", "warning", "issue"));

    const log = emitter.toLog();

    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toContain("sarif-schema-2.1.0");
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]!.results).toHaveLength(1);
  });

  it("passes custom properties to run", () => {
    const run = emitter.toRun({ customKey: "customValue" });

    expect(run.properties?.["customKey"]).toBe("customValue");
  });

  it("counts statistics correctly with all-same level", () => {
    emitter.emitAll([
      makeResult("test/rule-1", "warning", "w1"),
      makeResult("test/rule-1", "warning", "w2"),
      makeResult("test/rule-1", "warning", "w3"),
    ]);

    const run = emitter.toRun();
    const stats = run.properties?.statistics;

    expect(stats!.totalResults).toBe(3);
    expect(stats!.warningCount).toBe(3);
    expect(stats!.errorCount).toBe(0);
    expect(stats!.noteCount).toBe(0);
    expect(stats!.rulesTriggered).toBe(1);
  });

  it("handles empty emitter producing valid output", () => {
    const log = emitter.toLog();

    expect(log.runs[0]!.results).toHaveLength(0);
    const stats = log.runs[0]!.properties?.statistics;
    expect(stats!.totalResults).toBe(0);
    expect(stats!.rulesTriggered).toBe(0);
  });
});
