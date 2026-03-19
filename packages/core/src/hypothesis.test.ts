/**
 * Tests for hypothesis providers and reflexion engines.
 */

import { describe, it, expect } from "vitest";
import {
  HeuristicArchitectureProvider,
  ArchitectureReflexionEngine,
  HeuristicConfigConstraintProvider,
  HeuristicHazardPriorityProvider,
} from "./hypothesis.js";
import type {
  ArchitectureHypothesis,
  HazardEntry,
} from "./hypothesis.js";
import type { FeatureConstraint, InferredArchitecture, DetectedPattern } from "./types.js";

// ---------------------------------------------------------------------------
// HeuristicArchitectureProvider
// ---------------------------------------------------------------------------

describe("HeuristicArchitectureProvider", () => {
  it("produces hypothesis from inferred architecture", async () => {
    const arch: InferredArchitecture = {
      repo: "test",
      patterns: [] as DetectedPattern[],
      services: [
        { name: "api", rootPath: "src/api", confidence: 0.9, dependencies: ["db", "auth"], entryPoints: [] },
        { name: "db", rootPath: "src/db", confidence: 0.8, dependencies: [], entryPoints: [] },
      ],
    };
    const provider = new HeuristicArchitectureProvider(arch);

    const hypothesis = await provider.getHypothesis();

    expect(hypothesis.services).toHaveLength(2);
    expect(hypothesis.services[0]!.name).toBe("api");
    expect(hypothesis.services[0]!.expectedDependencies).toEqual(["db", "auth"]);
    expect(hypothesis.boundaries).toEqual([]);
  });

  it("calculates average confidence from services", () => {
    const arch: InferredArchitecture = {
      repo: "test",
      patterns: [] as DetectedPattern[],
      services: [
        { name: "a", rootPath: "a", confidence: 0.8, dependencies: [], entryPoints: [] },
        { name: "b", rootPath: "b", confidence: 0.6, dependencies: [], entryPoints: [] },
      ],
    };
    const provider = new HeuristicArchitectureProvider(arch);

    expect(provider.getConfidence()).toBeCloseTo(0.7);
  });

  it("returns 0 confidence when no services", () => {
    const arch: InferredArchitecture = { repo: "test", patterns: [] as DetectedPattern[], services: [] };
    const provider = new HeuristicArchitectureProvider(arch);

    expect(provider.getConfidence()).toBe(0);
  });

  it("reports heuristic source", () => {
    const arch: InferredArchitecture = { repo: "test", patterns: [] as DetectedPattern[], services: [] };
    const provider = new HeuristicArchitectureProvider(arch);

    expect(provider.getSource()).toBe("heuristic");
  });
});

// ---------------------------------------------------------------------------
// ArchitectureReflexionEngine
// ---------------------------------------------------------------------------

describe("ArchitectureReflexionEngine", () => {
  const engine = new ArchitectureReflexionEngine();

  it("detects convergences when services match", () => {
    const hypothesis: ArchitectureHypothesis = {
      services: [
        { name: "api", rootPath: "src/api", expectedDependencies: [] },
        { name: "db", rootPath: "src/db", expectedDependencies: [] },
      ],
      boundaries: [],
    };
    const extracted: ArchitectureHypothesis = {
      services: [
        { name: "api", rootPath: "src/api", expectedDependencies: [] },
        { name: "db", rootPath: "src/db", expectedDependencies: [] },
      ],
      boundaries: [],
    };

    const result = engine.compare(hypothesis, extracted);

    expect(result.convergences).toHaveLength(2);
    expect(result.divergences).toHaveLength(0);
    expect(result.absences).toHaveLength(0);
  });

  it("detects absences for expected services not found", () => {
    const hypothesis: ArchitectureHypothesis = {
      services: [{ name: "api", rootPath: "src/api", expectedDependencies: [] }],
      boundaries: [],
    };
    const extracted: ArchitectureHypothesis = {
      services: [],
      boundaries: [],
    };

    const result = engine.compare(hypothesis, extracted);

    expect(result.absences).toHaveLength(1);
    expect(result.absences[0]).toContain("api");
    expect(result.absences[0]).toContain("not found");
  });

  it("detects divergences for unexpected services", () => {
    const hypothesis: ArchitectureHypothesis = {
      services: [],
      boundaries: [],
    };
    const extracted: ArchitectureHypothesis = {
      services: [{ name: "rogue", rootPath: "src/rogue", expectedDependencies: [] }],
      boundaries: [],
    };

    const result = engine.compare(hypothesis, extracted);

    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]).toContain("rogue");
    expect(result.divergences[0]).toContain("Unexpected");
  });

  it("handles mixed convergences, divergences, and absences", () => {
    const hypothesis: ArchitectureHypothesis = {
      services: [
        { name: "api", rootPath: "src/api", expectedDependencies: [] },
        { name: "auth", rootPath: "src/auth", expectedDependencies: [] },
      ],
      boundaries: [],
    };
    const extracted: ArchitectureHypothesis = {
      services: [
        { name: "api", rootPath: "src/api", expectedDependencies: [] },
        { name: "cache", rootPath: "src/cache", expectedDependencies: [] },
      ],
      boundaries: [],
    };

    const result = engine.compare(hypothesis, extracted);

    expect(result.convergences).toHaveLength(1); // api
    expect(result.absences).toHaveLength(1);     // auth missing
    expect(result.divergences).toHaveLength(1);  // cache unexpected
  });

  it("validates allowed boundary present → convergence", () => {
    const hypothesis: ArchitectureHypothesis = {
      services: [{ name: "api", rootPath: "src/api", expectedDependencies: [] }],
      boundaries: [{ from: "api", to: "db", allowed: true }],
    };
    const extracted: ArchitectureHypothesis = {
      services: [{ name: "api", rootPath: "src/api", expectedDependencies: ["db"] }],
      boundaries: [],
    };

    const result = engine.compare(hypothesis, extracted);

    expect(result.convergences.some((c) => c.includes("allowed and present"))).toBe(true);
  });

  it("validates allowed boundary absent → absence", () => {
    const hypothesis: ArchitectureHypothesis = {
      services: [{ name: "api", rootPath: "src/api", expectedDependencies: [] }],
      boundaries: [{ from: "api", to: "db", allowed: true }],
    };
    const extracted: ArchitectureHypothesis = {
      services: [{ name: "api", rootPath: "src/api", expectedDependencies: [] }],
      boundaries: [],
    };

    const result = engine.compare(hypothesis, extracted);

    expect(result.absences.some((a) => a.includes("Expected dependency") && a.includes("api") && a.includes("db"))).toBe(true);
  });

  it("validates forbidden boundary present → divergence", () => {
    const hypothesis: ArchitectureHypothesis = {
      services: [{ name: "api", rootPath: "src/api", expectedDependencies: [] }],
      boundaries: [{ from: "api", to: "internal", allowed: false }],
    };
    const extracted: ArchitectureHypothesis = {
      services: [{ name: "api", rootPath: "src/api", expectedDependencies: ["internal"] }],
      boundaries: [],
    };

    const result = engine.compare(hypothesis, extracted);

    expect(result.divergences.some((d) => d.includes("Forbidden dependency"))).toBe(true);
  });

  it("validates forbidden boundary absent → convergence", () => {
    const hypothesis: ArchitectureHypothesis = {
      services: [{ name: "api", rootPath: "src/api", expectedDependencies: [] }],
      boundaries: [{ from: "api", to: "internal", allowed: false }],
    };
    const extracted: ArchitectureHypothesis = {
      services: [{ name: "api", rootPath: "src/api", expectedDependencies: [] }],
      boundaries: [],
    };

    const result = engine.compare(hypothesis, extracted);

    expect(result.convergences.some((c) => c.includes("forbidden and absent"))).toBe(true);
  });

  it("skips boundary check when source service not found in extracted", () => {
    const hypothesis: ArchitectureHypothesis = {
      services: [],
      boundaries: [{ from: "missing", to: "db", allowed: true }],
    };
    const extracted: ArchitectureHypothesis = {
      services: [],
      boundaries: [],
    };

    const result = engine.compare(hypothesis, extracted);

    // Boundary should be silently skipped since "missing" service not in extracted
    expect(result.convergences).toHaveLength(0);
    expect(result.divergences).toHaveLength(0);
    expect(result.absences).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HeuristicConfigConstraintProvider
// ---------------------------------------------------------------------------

describe("HeuristicConfigConstraintProvider", () => {
  it("filters to inferred constraints only", async () => {
    const constraints: FeatureConstraint[] = [
      { kind: "requires", flags: ["BETA", "AUTH"], description: "BETA requires AUTH", source: "inferred" },
      { kind: "excludes", flags: ["V1", "V2"], description: "V1 excludes V2", source: "human" },
    ];
    const provider = new HeuristicConfigConstraintProvider(constraints);

    const hypothesis = await provider.getHypothesis();

    expect(hypothesis.constraints).toHaveLength(1);
    expect(hypothesis.constraints[0]!.source).toBe("inferred");
  });

  it("returns ~0.28 confidence when inferred constraints exist", async () => {
    const constraints: FeatureConstraint[] = [
      { kind: "requires", flags: ["A", "B"], description: "A requires B", source: "inferred" },
    ];
    const provider = new HeuristicConfigConstraintProvider(constraints);

    await provider.getHypothesis(); // Must call first to compute confidence
    expect(provider.getConfidence()).toBeCloseTo(0.28);
  });

  it("returns 0 confidence when no inferred constraints", async () => {
    const constraints: FeatureConstraint[] = [
      { kind: "requires", flags: ["A", "B"], description: "A requires B", source: "human" },
    ];
    const provider = new HeuristicConfigConstraintProvider(constraints);

    await provider.getHypothesis();
    expect(provider.getConfidence()).toBe(0);
  });

  it("reports heuristic source", () => {
    const provider = new HeuristicConfigConstraintProvider([]);
    expect(provider.getSource()).toBe("heuristic");
  });
});

// ---------------------------------------------------------------------------
// HeuristicHazardPriorityProvider
// ---------------------------------------------------------------------------

describe("HeuristicHazardPriorityProvider", () => {
  const hazard: HazardEntry = {
    id: "H1",
    description: "Unvalidated input",
    severity: "high",
    location: { repo: "test", module: "api/handler.ts" },
    mitigations: ["input validation"],
  };

  it("returns provided hazards as hypothesis", async () => {
    const provider = new HeuristicHazardPriorityProvider([hazard]);

    const hypothesis = await provider.getHypothesis();

    expect(hypothesis.hazards).toHaveLength(1);
    expect(hypothesis.hazards[0]!.id).toBe("H1");
  });

  it("returns 0.5 confidence when hazards exist", () => {
    const provider = new HeuristicHazardPriorityProvider([hazard]);
    expect(provider.getConfidence()).toBe(0.5);
  });

  it("returns 0 confidence when no hazards", () => {
    const provider = new HeuristicHazardPriorityProvider([]);
    expect(provider.getConfidence()).toBe(0);
  });

  it("reports heuristic source", () => {
    const provider = new HeuristicHazardPriorityProvider([]);
    expect(provider.getSource()).toBe("heuristic");
  });
});
