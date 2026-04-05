/**
 * Tests for detectMissingErrorBoundaries — validates that Promise .catch()
 * chains and error callback patterns are recognized as error handling,
 * reducing false positives.
 */

import { describe, it, expect } from "vitest";
import type { ControlFlowGraph, ControlFlowNode, CfgEdge } from "@mma/core";
import { detectMissingErrorBoundaries } from "./ast-utils.js";

function makeCfg(
  functionId: string,
  nodes: ControlFlowNode[],
  edges: CfgEdge[] = [],
): ControlFlowGraph {
  return { functionId, nodes, edges };
}

function stmt(label: string, id = "s1"): ControlFlowNode {
  return {
    id,
    kind: "statement",
    label,
    location: { repo: "test", module: "test.ts" },
  };
}

function node(kind: ControlFlowNode["kind"], label: string, id = "n1"): ControlFlowNode {
  return {
    id,
    kind,
    label,
    location: { repo: "test", module: "test.ts" },
  };
}

describe("detectMissingErrorBoundaries", () => {
  it("flags async function with await and no error handling", () => {
    const cfgs = new Map([
      ["test.ts#doWork", makeCfg("test.ts#doWork", [
        node("entry", "entry", "e"),
        stmt("const result = await fetch(url)"),
        node("exit", "exit", "x"),
      ])],
    ]);

    const results = detectMissingErrorBoundaries(cfgs, "test-repo");
    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("fault/missing-error-boundary");
  });

  it("does not flag function with try/catch", () => {
    const cfgs = new Map([
      ["test.ts#doWork", makeCfg("test.ts#doWork", [
        node("entry", "entry", "e"),
        node("try", "try", "t"),
        stmt("const result = await fetch(url)"),
        node("catch", "catch (err)", "c"),
        node("exit", "exit", "x"),
      ])],
    ]);

    const results = detectMissingErrorBoundaries(cfgs, "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag function with .catch() promise chain", () => {
    const cfgs = new Map([
      ["test.ts#doWork", makeCfg("test.ts#doWork", [
        node("entry", "entry", "e"),
        stmt("const result = await fetch(url).catch(err => null)", "s1"),
        node("exit", "exit", "x"),
      ])],
    ]);

    const results = detectMissingErrorBoundaries(cfgs, "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag function with separate .catch() statement", () => {
    const cfgs = new Map([
      ["test.ts#doWork", makeCfg("test.ts#doWork", [
        node("entry", "entry", "e"),
        stmt("const promise = await this.service.run()", "s1"),
        stmt("promise.catch(handleError)", "s2"),
        node("exit", "exit", "x"),
      ])],
    ]);

    const results = detectMissingErrorBoundaries(cfgs, "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag function with catchError (RxJS)", () => {
    const cfgs = new Map([
      ["test.ts#doWork", makeCfg("test.ts#doWork", [
        node("entry", "entry", "e"),
        stmt("const result = await firstValueFrom(obs.pipe(catchError(err => of(null))))", "s1"),
        node("exit", "exit", "x"),
      ])],
    ]);

    const results = detectMissingErrorBoundaries(cfgs, "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag function with onError callback", () => {
    const cfgs = new Map([
      ["test.ts#doWork", makeCfg("test.ts#doWork", [
        node("entry", "entry", "e"),
        stmt("const result = await this.client.request({ onError(err) { log(err) } })", "s1"),
        node("exit", "exit", "x"),
      ])],
    ]);

    const results = detectMissingErrorBoundaries(cfgs, "test-repo");
    expect(results).toHaveLength(0);
  });

  it("does not flag anonymous functions (callbacks propagate to caller)", () => {
    const cfgs = new Map([
      ["test.ts#anon_42", makeCfg("test.ts#anon_42", [
        node("entry", "entry", "e"),
        stmt("const result = await fetch(url)"),
        node("exit", "exit", "x"),
      ])],
    ]);

    const results = detectMissingErrorBoundaries(cfgs, "test-repo");
    expect(results).toHaveLength(0);
  });

  it("flags named async function with await and no error handling at note level", () => {
    const cfgs = new Map([
      ["test.ts#processData", makeCfg("test.ts#processData", [
        node("entry", "entry", "e"),
        stmt("const result = await db.query(sql)"),
        node("exit", "exit", "x"),
      ])],
    ]);

    const results = detectMissingErrorBoundaries(cfgs, "test-repo");
    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("fault/missing-error-boundary");
    expect(results[0]!.message.text).toContain("processData");
  });

  it("does not flag functions without await", () => {
    const cfgs = new Map([
      ["test.ts#syncWork", makeCfg("test.ts#syncWork", [
        node("entry", "entry", "e"),
        stmt("const result = doSomething()"),
        node("exit", "exit", "x"),
      ])],
    ]);

    const results = detectMissingErrorBoundaries(cfgs, "test-repo");
    expect(results).toHaveLength(0);
  });

  it("skips functions in scripts/ directories", () => {
    const cfgs = new Map([
      ["scripts/prodrunner.js#getClient", makeCfg("scripts/prodrunner.js#getClient", [
        stmt("const client = await connect()"),
      ])],
    ]);

    const results = detectMissingErrorBoundaries(cfgs, "test-repo");
    expect(results).toHaveLength(0);
  });

  it("skips functions in test/ directories", () => {
    const cfgs = new Map([
      ["test/helpers.ts#setup", makeCfg("test/helpers.ts#setup", [
        stmt("await db.connect()"),
      ])],
    ]);

    const results = detectMissingErrorBoundaries(cfgs, "test-repo");
    expect(results).toHaveLength(0);
  });
});
