/**
 * Integration tests: Heuristics functions with manually-constructed symbol maps.
 *
 * Tests the real heuristic functions (detectPatterns, analyzeNaming,
 * inferServicesWithMeta, etc.) using constructed SymbolInfo inputs,
 * mirroring the approach used in existing unit tests.
 */

import { describe, it, expect } from "vitest";
import type { SymbolInfo, DependencyGraph } from "@mma/core";
import { detectPatterns, detectPatternsWithMeta } from "./patterns.js";
import { analyzeNaming, analyzeNamingWithMeta } from "./naming.js";
import { inferServicesWithMeta } from "./services.js";
import type { PatternDetectionInput } from "./patterns.js";
import type { ServiceInferenceInput } from "./services.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSymbol(
  name: string,
  kind: SymbolInfo["kind"],
  opts: Partial<Pick<SymbolInfo, "exported" | "containerName">> = {},
): SymbolInfo {
  return {
    name,
    kind,
    startLine: 1,
    endLine: 10,
    exported: opts.exported ?? false,
    containerName: opts.containerName,
  };
}

function emptyDepGraph(): DependencyGraph {
  return { repo: "test-repo", edges: [], circularDependencies: [] };
}

// ---------------------------------------------------------------------------
// detectPatterns
// ---------------------------------------------------------------------------

describe("detectPatterns -> adapter/singleton patterns", () => {
  it("detects adapter pattern from class name ending in Adapter", () => {
    const symbols = new Map<string, readonly SymbolInfo[]>([
      ["src/http-adapter.ts", [makeSymbol("HttpAdapter", "class")]],
    ]);
    const input: PatternDetectionInput = {
      repo: "test-repo",
      symbols,
      imports: new Map(),
    };

    const patterns = detectPatterns(input);
    const adapters = patterns.filter((p) => p.kind === "adapter");
    expect(adapters).toHaveLength(1);
    expect(adapters[0]!.name).toBe("adapter: HttpAdapter");
    expect(adapters[0]!.confidence).toBeGreaterThan(0);
  });

  it("detects singleton pattern via getInstance method", () => {
    const symbols = new Map<string, readonly SymbolInfo[]>([
      [
        "src/config.ts",
        [
          makeSymbol("Config", "class"),
          makeSymbol("getInstance", "method", { containerName: "Config" }),
        ],
      ],
    ]);
    const input: PatternDetectionInput = {
      repo: "test-repo",
      symbols,
      imports: new Map(),
    };

    const patterns = detectPatterns(input);
    const singletons = patterns.filter((p) => p.kind === "singleton");
    expect(singletons).toHaveLength(1);
    expect(singletons[0]!.name).toContain("Config");
    expect(singletons[0]!.confidence).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeNaming
// ---------------------------------------------------------------------------

describe("analyzeNaming -> verb extraction", () => {
  it("extracts verb and object from standard camelCase function names", () => {
    const files = new Map<string, readonly SymbolInfo[]>([
      [
        "src/user-service.ts",
        [
          makeSymbol("getUserById", "function"),
          makeSymbol("createOrder", "function"),
          makeSymbol("deleteRecord", "function"),
        ],
      ],
    ]);

    const result = analyzeNaming(files, "test-repo");
    expect(result.repo).toBe("test-repo");

    const methods = result.methods;
    const getMethod = methods.find((m) => m.methodId.includes("getUserById"));
    expect(getMethod).toBeDefined();
    expect(getMethod!.verb).toBe("get");
    expect(getMethod!.object).toContain("user");

    const createMethod = methods.find((m) => m.methodId.includes("createOrder"));
    expect(createMethod).toBeDefined();
    expect(createMethod!.verb).toBe("create");
  });

  it("analyzeNaming handles predicate methods (isValid, hasPermission)", () => {
    const files = new Map<string, readonly SymbolInfo[]>([
      [
        "src/auth.ts",
        [
          makeSymbol("isValid", "function"),
          makeSymbol("hasPermission", "function"),
        ],
      ],
    ]);

    const result = analyzeNaming(files, "test-repo");
    const isValidEntry = result.methods.find((m) => m.methodId.includes("isValid"));
    expect(isValidEntry).toBeDefined();
    expect(isValidEntry!.verb).toBe("check");
  });
});

// ---------------------------------------------------------------------------
// WithMeta wrappers
// ---------------------------------------------------------------------------

describe("inferServicesWithMeta -> meta fields", () => {
  it("returns correct meta fields: repo, heuristic, durationMs, itemCount", () => {
    const input: ServiceInferenceInput = {
      repo: "svc-repo",
      filePaths: ["apps/api/src/index.ts", "apps/worker/src/index.ts"],
      packageJsons: new Map(),
      dependencyGraph: emptyDepGraph(),
    };

    const result = inferServicesWithMeta(input);
    expect(result.meta.repo).toBe("svc-repo");
    expect(result.meta.heuristic).toBe("inferServices");
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.meta.itemCount).toBe("number");
    expect(Array.isArray(result.data)).toBe(true);
  });
});

describe("detectPatternsWithMeta -> meta fields", () => {
  it("returns correct meta fields: repo, heuristic, durationMs", () => {
    const symbols = new Map<string, readonly SymbolInfo[]>([
      ["src/logger-adapter.ts", [makeSymbol("LoggerAdapter", "class")]],
    ]);
    const input: PatternDetectionInput = {
      repo: "pattern-repo",
      symbols,
      imports: new Map(),
    };

    const result = detectPatternsWithMeta(input);
    expect(result.meta.repo).toBe("pattern-repo");
    expect(result.meta.heuristic).toBe("detectPatterns");
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("analyzeNamingWithMeta -> meta fields", () => {
  it("returns correct meta fields: repo, heuristic, itemCount", () => {
    const files = new Map<string, readonly SymbolInfo[]>([
      ["src/svc.ts", [makeSymbol("fetchData", "function")]],
    ]);

    const result = analyzeNamingWithMeta(files, "naming-repo");
    expect(result.meta.repo).toBe("naming-repo");
    expect(result.meta.heuristic).toBe("analyzeNaming");
    expect(result.meta.itemCount).toBeGreaterThanOrEqual(0);
    expect(result.data.repo).toBe("naming-repo");
  });
});

// ---------------------------------------------------------------------------
// Boundary cases
// ---------------------------------------------------------------------------

describe("detectPatterns -> empty input", () => {
  it("returns empty array for empty symbol map", () => {
    const input: PatternDetectionInput = {
      repo: "empty-repo",
      symbols: new Map(),
      imports: new Map(),
    };
    expect(detectPatterns(input)).toEqual([]);
  });
});

describe("analyzeNaming -> empty input", () => {
  it("returns empty methods array for empty files map", () => {
    const result = analyzeNaming(new Map(), "empty-repo");
    expect(result.repo).toBe("empty-repo");
    expect(result.methods).toHaveLength(0);
  });
});
