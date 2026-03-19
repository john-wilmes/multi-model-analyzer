/**
 * Hypothesis provider abstraction and reflexion engine.
 *
 * Three hypothesis domains:
 * 1. ArchitectureHypothesis -- expected service boundaries, module structure
 * 2. ConfigConstraintHypothesis -- expected flag dependencies, valid combinations
 * 3. HazardPriorityHypothesis -- expected failure modes, safety-critical paths
 *
 * Each has a default heuristic implementation and a human-input implementation.
 */

import type {
  FeatureConstraint,
  InferredArchitecture,
  LogicalLocation,
} from "./types.js";

// -- Generic interfaces --

export type HypothesisSource = "heuristic" | "human" | "hybrid";

export interface HypothesisProvider<T> {
  getHypothesis(): Promise<T>;
  getConfidence(): number;
  getSource(): HypothesisSource;
}

export interface ReflexionResult {
  readonly convergences: readonly string[];
  readonly divergences: readonly string[];
  readonly absences: readonly string[];
}

export interface ReflexionEngine<T> {
  compare(hypothesis: T, extracted: T): ReflexionResult;
}

// -- Architecture Hypothesis --

export interface ArchitectureHypothesis {
  readonly services: readonly ExpectedService[];
  readonly boundaries: readonly ServiceBoundary[];
}

export interface ExpectedService {
  readonly name: string;
  readonly rootPath: string;
  readonly expectedDependencies: readonly string[];
}

export interface ServiceBoundary {
  readonly from: string;
  readonly to: string;
  readonly allowed: boolean;
  readonly reason?: string;
}

export class HeuristicArchitectureProvider
  implements HypothesisProvider<ArchitectureHypothesis>
{
  private readonly confidence: number;

  constructor(private readonly architecture: InferredArchitecture) {
    const svcs = architecture.services;
    this.confidence = svcs.length > 0
      ? svcs.reduce((sum, s) => sum + s.confidence, 0) / svcs.length
      : 0;
  }

  async getHypothesis(): Promise<ArchitectureHypothesis> {
    const services: ExpectedService[] = this.architecture.services.map((s) => ({
      name: s.name,
      rootPath: s.rootPath,
      expectedDependencies: [...s.dependencies],
    }));

    return {
      services,
      boundaries: [],
    };
  }

  getConfidence(): number {
    return this.confidence;
  }

  getSource(): HypothesisSource {
    return "heuristic";
  }
}

export class ArchitectureReflexionEngine
  implements ReflexionEngine<ArchitectureHypothesis>
{
  compare(
    hypothesis: ArchitectureHypothesis,
    extracted: ArchitectureHypothesis,
  ): ReflexionResult {
    const convergences: string[] = [];
    const divergences: string[] = [];
    const absences: string[] = [];

    const extractedNames = new Set(extracted.services.map((s) => s.name));
    const hypothesisNames = new Set(hypothesis.services.map((s) => s.name));

    const hypothesisServiceMap = new Map(hypothesis.services.map((s) => [s.name, s]));
    const extractedServiceMap = new Map(extracted.services.map((s) => [s.name, s]));

    for (const name of hypothesisNames) {
      if (extractedNames.has(name)) {
        convergences.push(`Service "${name}" found in both hypothesis and extraction`);

        // Diff expectedDependencies for services present in both
        const hypDeps = new Set(hypothesisServiceMap.get(name)!.expectedDependencies);
        const extDeps = new Set(extractedServiceMap.get(name)!.expectedDependencies);

        for (const dep of hypDeps) {
          if (extDeps.has(dep)) {
            convergences.push(`Service "${name}": dependency "${dep}" present in both`);
          } else {
            absences.push(`Service "${name}": expected dependency "${dep}" not found in extracted`);
          }
        }
        for (const dep of extDeps) {
          if (!hypDeps.has(dep)) {
            divergences.push(`Service "${name}": unexpected dependency "${dep}" found in extracted`);
          }
        }
      } else {
        absences.push(`Expected service "${name}" not found in extracted architecture`);
      }
    }

    for (const name of extractedNames) {
      if (!hypothesisNames.has(name)) {
        divergences.push(`Unexpected service "${name}" found in extracted architecture`);
      }
    }

    for (const boundary of hypothesis.boundaries) {
      const actualDeps = extracted.services.find(
        (s) => s.name === boundary.from,
      )?.expectedDependencies;
      if (!actualDeps) continue;

      const hasDep = actualDeps.includes(boundary.to);
      if (boundary.allowed && !hasDep) {
        absences.push(
          `Expected dependency ${boundary.from} -> ${boundary.to} not found`,
        );
      } else if (!boundary.allowed && hasDep) {
        divergences.push(
          `Forbidden dependency ${boundary.from} -> ${boundary.to} exists`,
        );
      } else {
        convergences.push(
          `Boundary ${boundary.from} -> ${boundary.to}: ${boundary.allowed ? "allowed and present" : "forbidden and absent"}`,
        );
      }
    }

    return { convergences, divergences, absences };
  }
}

// -- Config Constraint Hypothesis --

export interface ConfigConstraintHypothesis {
  readonly constraints: readonly FeatureConstraint[];
}

export class HeuristicConfigConstraintProvider
  implements HypothesisProvider<ConfigConstraintHypothesis>
{
  private readonly inferred: readonly FeatureConstraint[];
  private readonly confidence: number;

  constructor(constraints: readonly FeatureConstraint[]) {
    this.inferred = constraints.filter((c) => c.source === "inferred");
    this.confidence = this.inferred.length > 0 ? 0.28 : 0; // ~28% per Nadi 2015
  }

  async getHypothesis(): Promise<ConfigConstraintHypothesis> {
    return { constraints: this.inferred };
  }

  getConfidence(): number {
    return this.confidence;
  }

  getSource(): HypothesisSource {
    return "heuristic";
  }
}

// -- Hazard Priority Hypothesis --

export interface HazardPriorityHypothesis {
  readonly hazards: readonly HazardEntry[];
}

export interface HazardEntry {
  readonly id: string;
  readonly description: string;
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly location: LogicalLocation;
  readonly mitigations: readonly string[];
}

export class HeuristicHazardPriorityProvider
  implements HypothesisProvider<HazardPriorityHypothesis>
{
  constructor(private readonly hazards: readonly HazardEntry[]) {}

  async getHypothesis(): Promise<HazardPriorityHypothesis> {
    return { hazards: this.hazards };
  }

  getConfidence(): number {
    return this.hazards.length > 0 ? 0.5 : 0;
  }

  getSource(): HypothesisSource {
    return "heuristic";
  }
}
