/**
 * Integration tests: Heuristics → Models data shape validation.
 *
 * Tests that inferServices + detectPatterns feed correctly into
 * buildArchitecture, producing a valid InferredArchitecture shape.
 */

import { describe, it, expect } from "vitest";
import type { SymbolInfo, DependencyGraph } from "@mma/core";
import { inferServices, buildArchitecture } from "./services.js";
import { detectPatterns } from "./patterns.js";
import type { ServiceInferenceInput } from "./services.js";
import type { PatternDetectionInput } from "./patterns.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyDepGraph(repo = "test-repo"): DependencyGraph {
  return { repo, edges: [], circularDependencies: [] };
}

function makeSymbol(
  name: string,
  kind: SymbolInfo["kind"],
  containerName?: string,
): SymbolInfo {
  return { name, kind, startLine: 1, endLine: 5, exported: false, containerName };
}

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------

describe("inferServices + detectPatterns -> buildArchitecture round-trip", () => {
  it("produces a valid InferredArchitecture with services and patterns arrays", () => {
    const serviceInput: ServiceInferenceInput = {
      repo: "my-repo",
      filePaths: [
        "apps/api/src/index.ts",
        "apps/worker/src/index.ts",
      ],
      packageJsons: new Map(),
      dependencyGraph: emptyDepGraph("my-repo"),
    };

    const patternInput: PatternDetectionInput = {
      repo: "my-repo",
      symbols: new Map<string, readonly SymbolInfo[]>([
        ["src/db-adapter.ts", [makeSymbol("DbAdapter", "class")]],
      ]),
      imports: new Map(),
    };

    const services = inferServices(serviceInput);
    const patterns = detectPatterns(patternInput);
    const arch = buildArchitecture("my-repo", services, patterns);

    expect(arch.repo).toBe("my-repo");
    expect(Array.isArray(arch.services)).toBe(true);
    expect(Array.isArray(arch.patterns)).toBe(true);
    // inferServices picks up apps/* directories
    expect(arch.services.length).toBeGreaterThanOrEqual(1);
    // detectPatterns finds DbAdapter
    expect(arch.patterns.length).toBeGreaterThanOrEqual(1);
  });

  it("architecture with services carries correct repo field on each service", () => {
    const serviceInput: ServiceInferenceInput = {
      repo: "backend",
      filePaths: ["services/auth/src/index.ts"],
      packageJsons: new Map(),
      dependencyGraph: emptyDepGraph("backend"),
    };

    const services = inferServices(serviceInput);
    const arch = buildArchitecture("backend", services, []);

    expect(arch.repo).toBe("backend");
    for (const svc of arch.services) {
      expect(svc.name).toBeDefined();
      expect(typeof svc.rootPath).toBe("string");
      expect(typeof svc.confidence).toBe("number");
    }
  });

  it("zero-service boundary case: empty services + empty patterns", () => {
    const arch = buildArchitecture("empty-repo", [], []);

    expect(arch.repo).toBe("empty-repo");
    expect(arch.services).toHaveLength(0);
    expect(arch.patterns).toHaveLength(0);
  });

  it("repo field propagates correctly through the pipeline", () => {
    const repo = "propagation-test";
    const serviceInput: ServiceInferenceInput = {
      repo,
      filePaths: ["packages/core/src/index.ts"],
      packageJsons: new Map(),
      dependencyGraph: emptyDepGraph(repo),
    };

    const services = inferServices(serviceInput);
    const arch = buildArchitecture(repo, services, []);

    expect(arch.repo).toBe(repo);
  });

  it("architecture patterns array matches the input patterns exactly", () => {
    const patternInput: PatternDetectionInput = {
      repo: "shape-test",
      symbols: new Map<string, readonly SymbolInfo[]>([
        [
          "src/log-facade.ts",
          [makeSymbol("LogFacade", "class")],
        ],
        [
          "src/cache-proxy.ts",
          [makeSymbol("CacheProxy", "class")],
        ],
      ]),
      imports: new Map(),
    };

    const patterns = detectPatterns(patternInput);
    const arch = buildArchitecture("shape-test", [], patterns);

    // arch.patterns should be exactly the patterns we passed in
    expect(arch.patterns).toHaveLength(patterns.length);
    for (let i = 0; i < patterns.length; i++) {
      expect(arch.patterns[i]).toBe(patterns[i]);
    }
  });
});
