import { describe, it, expect } from "vitest";
import { detectPatterns } from "./patterns.js";
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
});
