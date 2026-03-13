import { describe, it, expect } from "vitest";
import { detectPatterns, detectPatternsWithMeta } from "./patterns.js";
import type { PatternDetectionInput } from "./patterns.js";
import type { SymbolInfo } from "@mma/core";

function sym(name: string, kind: SymbolInfo["kind"], containerName?: string): SymbolInfo {
  return { name, kind, startLine: 1, endLine: 10, exported: true, containerName };
}

function makeInput(
  symbols: Map<string, readonly SymbolInfo[]>,
  imports?: Map<string, readonly string[]>,
): PatternDetectionInput {
  return {
    repo: "test-repo",
    symbols,
    imports: imports ?? new Map(),
  };
}

describe("detectPatterns", () => {
  it("detects factory pattern by naming", () => {
    const input = makeInput(
      new Map([["src/factory.ts", [sym("UserFactory", "class")]]]),
    );
    const patterns = detectPatterns(input);
    const factories = patterns.filter((p) => p.kind === "factory");
    expect(factories).toHaveLength(1);
    expect(factories[0]!.name).toContain("UserFactory");
    expect(factories[0]!.confidence).toBeGreaterThan(0);
  });

  it("detects singleton pattern by getInstance method", () => {
    const input = makeInput(
      new Map([
        [
          "src/db.ts",
          [
            sym("Database", "class"),
            sym("getInstance", "method", "Database"),
          ],
        ],
      ]),
    );
    const patterns = detectPatterns(input);
    const singletons = patterns.filter((p) => p.kind === "singleton");
    expect(singletons).toHaveLength(1);
    expect(singletons[0]!.name).toContain("Database");
  });

  it("detects observer pattern by subscribe + emit methods", () => {
    const input = makeInput(
      new Map([
        [
          "src/events.ts",
          [
            sym("EventBus", "class"),
            sym("subscribe", "method", "EventBus"),
            sym("emit", "method", "EventBus"),
          ],
        ],
      ]),
    );
    const patterns = detectPatterns(input);
    const observers = patterns.filter((p) => p.kind === "observer");
    expect(observers).toHaveLength(1);
    expect(observers[0]!.name).toContain("EventBus");
  });

  it("does not detect observer when only subscribe is present", () => {
    const input = makeInput(
      new Map([
        [
          "src/events.ts",
          [
            sym("EventBus", "class"),
            sym("subscribe", "method", "EventBus"),
          ],
        ],
      ]),
    );
    const patterns = detectPatterns(input);
    const observers = patterns.filter((p) => p.kind === "observer");
    expect(observers).toHaveLength(0);
  });

  it("returns empty array when no patterns match", () => {
    const input = makeInput(
      new Map([["src/utils.ts", [sym("add", "function")]]]),
    );
    const patterns = detectPatterns(input);
    expect(patterns).toHaveLength(0);
  });

  it("detects multiple patterns across files", () => {
    const input = makeInput(
      new Map([
        ["src/a.ts", [sym("LogAdapter", "class")]],
        ["src/b.ts", [sym("CacheFacade", "class")]],
        ["src/c.ts", [sym("UserRepository", "class")]],
      ]),
    );
    const patterns = detectPatterns(input);
    expect(patterns.some((p) => p.kind === "adapter")).toBe(true);
    expect(patterns.some((p) => p.kind === "facade")).toBe(true);
    expect(patterns.some((p) => p.kind === "repository")).toBe(true);
  });

  it("detects interface-based patterns", () => {
    const input = makeInput(
      new Map([["src/d.ts", [sym("IUserRepository", "interface")]]]),
    );
    const patterns = detectPatterns(input);
    expect(patterns.some((p) => p.kind === "repository")).toBe(true);
  });

  it("detects builder pattern by naming", () => {
    const input = makeInput(
      new Map([["src/query.ts", [sym("QueryBuilder", "class")]]]),
    );
    const patterns = detectPatterns(input);
    const builders = patterns.filter((p) => p.kind === "builder");
    expect(builders).toHaveLength(1);
    expect(builders[0]!.name).toContain("QueryBuilder");
  });

  it("detects builder pattern by fluent interface (build + setters)", () => {
    const input = makeInput(
      new Map([
        [
          "src/config.ts",
          [
            sym("ConfigCreator", "class"),
            sym("setName", "method", "ConfigCreator"),
            sym("setPort", "method", "ConfigCreator"),
            sym("withTimeout", "method", "ConfigCreator"),
            sym("build", "method", "ConfigCreator"),
          ],
        ],
      ]),
    );
    const patterns = detectPatterns(input);
    const builders = patterns.filter((p) => p.kind === "builder");
    expect(builders).toHaveLength(1);
    expect(builders[0]!.name).toContain("ConfigCreator");
  });

  it("detects proxy pattern by naming", () => {
    const input = makeInput(
      new Map([["src/cache.ts", [sym("CacheProxy", "class")]]]),
    );
    const patterns = detectPatterns(input);
    const proxies = patterns.filter((p) => p.kind === "proxy");
    expect(proxies).toHaveLength(1);
    expect(proxies[0]!.name).toContain("CacheProxy");
  });

  it("detects strategy pattern by naming", () => {
    const input = makeInput(
      new Map([["src/pricing.ts", [sym("PricingStrategy", "class")]]]),
    );
    const patterns = detectPatterns(input);
    const strategies = patterns.filter((p) => p.kind === "strategy");
    expect(strategies).toHaveLength(1);
    expect(strategies[0]!.name).toContain("PricingStrategy");
  });

  it("detects strategy pattern by structural signature (Handler + execute)", () => {
    const input = makeInput(
      new Map([
        [
          "src/auth.ts",
          [
            sym("AuthHandler", "class"),
            sym("execute", "method", "AuthHandler"),
          ],
        ],
      ]),
    );
    const patterns = detectPatterns(input);
    const strategies = patterns.filter((p) => p.kind === "strategy");
    expect(strategies).toHaveLength(1);
    expect(strategies[0]!.name).toContain("AuthHandler");
  });

  it("does not detect builder when only build() is present (no setters)", () => {
    const input = makeInput(
      new Map([
        [
          "src/simple.ts",
          [
            sym("SimpleClass", "class"),
            sym("build", "method", "SimpleClass"),
          ],
        ],
      ]),
    );
    const patterns = detectPatterns(input);
    const builders = patterns.filter((p) => p.kind === "builder");
    expect(builders).toHaveLength(0);
  });
});

describe("detectPatternsWithMeta", () => {
  it("meta.heuristic equals 'detectPatterns'", () => {
    const input = makeInput(new Map());
    const result = detectPatternsWithMeta(input);
    expect(result.meta.heuristic).toBe("detectPatterns");
  });

  it("meta.itemCount matches data.length", () => {
    const input = makeInput(
      new Map([["src/factory.ts", [sym("UserFactory", "class")]]]),
    );
    const result = detectPatternsWithMeta(input);
    expect(result.meta.itemCount).toBe(result.data.length);
    expect(result.meta.itemCount).toBe(1);
  });

  it("confidenceStats undefined for empty symbols, populated when patterns exist", () => {
    const emptyResult = detectPatternsWithMeta(makeInput(new Map()));
    expect(emptyResult.meta.confidenceStats).toBeUndefined();

    const filledInput = makeInput(
      new Map([["src/factory.ts", [sym("UserFactory", "class")]]]),
    );
    const filledResult = detectPatternsWithMeta(filledInput);
    expect(filledResult.meta.confidenceStats).toBeDefined();
    expect(filledResult.meta.confidenceStats!.min).toBeGreaterThanOrEqual(0);
    expect(filledResult.meta.confidenceStats!.max).toBeLessThanOrEqual(1);
    expect(filledResult.meta.confidenceStats!.mean).toBeGreaterThanOrEqual(0);
  });
});
