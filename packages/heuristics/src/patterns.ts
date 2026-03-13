/**
 * Architectural pattern detection from structural signatures.
 *
 * Identifies common patterns (adapter, facade, observer, factory, etc.)
 * by analyzing class/interface hierarchies, naming conventions, and
 * dependency structures.
 */

import type { DetectedPattern, LogicalLocation, PatternKind, SymbolInfo, HeuristicResult } from "@mma/core";
import { runHeuristic } from "@mma/core";

export interface PatternDetectionInput {
  readonly repo: string;
  readonly symbols: ReadonlyMap<string, readonly SymbolInfo[]>;
  readonly imports: ReadonlyMap<string, readonly string[]>;
}

/**
 * Pre-partitioned symbol data for a single file. Built once in detectPatterns
 * and shared across all rule detectors to avoid repeated filter passes.
 */
export interface FileSymbolIndex {
  readonly classes: SymbolInfo[];
  readonly interfaces: SymbolInfo[];
  /** Methods grouped by their containerName for O(1) lookup per class. */
  readonly methodsByContainer: Map<string, SymbolInfo[]>;
}

function buildFileSymbolIndex(symbols: readonly SymbolInfo[]): FileSymbolIndex {
  const classes: SymbolInfo[] = [];
  const interfaces: SymbolInfo[] = [];
  const methodsByContainer = new Map<string, SymbolInfo[]>();

  for (const sym of symbols) {
    if (sym.kind === "class") {
      classes.push(sym);
    } else if (sym.kind === "interface") {
      interfaces.push(sym);
    } else if (sym.kind === "method" && sym.containerName !== undefined) {
      let bucket = methodsByContainer.get(sym.containerName);
      if (bucket === undefined) {
        bucket = [];
        methodsByContainer.set(sym.containerName, bucket);
      }
      bucket.push(sym);
    }
  }

  return { classes, interfaces, methodsByContainer };
}

interface PatternRule {
  readonly kind: PatternKind;
  readonly detect: (input: PatternDetectionInput, indexes: Map<string, FileSymbolIndex>) => DetectedPattern[];
}

const PATTERN_RULES: readonly PatternRule[] = [
  { kind: "adapter", detect: detectAdapterPattern },
  { kind: "facade", detect: detectFacadePattern },
  { kind: "factory", detect: detectFactoryPattern },
  { kind: "singleton", detect: detectSingletonPattern },
  { kind: "repository", detect: detectRepositoryPattern },
  { kind: "middleware", detect: detectMiddlewarePattern },
  { kind: "observer", detect: detectObserverPattern },
  { kind: "decorator", detect: detectDecoratorPattern },
  { kind: "builder", detect: detectBuilderPattern },
  { kind: "proxy", detect: detectProxyPattern },
  { kind: "strategy", detect: detectStrategyPattern },
];

export function detectPatterns(input: PatternDetectionInput): DetectedPattern[] {
  // Build per-file indexes once; all rule detectors share them.
  const indexes = new Map<string, FileSymbolIndex>();
  for (const [filePath, symbols] of input.symbols) {
    indexes.set(filePath, buildFileSymbolIndex(symbols));
  }

  const results: DetectedPattern[] = [];
  for (const rule of PATTERN_RULES) {
    results.push(...rule.detect(input, indexes));
  }
  return results;
}

export function detectPatternsWithMeta(input: PatternDetectionInput): HeuristicResult<DetectedPattern[]> {
  return runHeuristic(input.repo, "detectPatterns", () => detectPatterns(input), (d) => d);
}

function detectAdapterPattern(input: PatternDetectionInput, indexes: Map<string, FileSymbolIndex>): DetectedPattern[] {
  return detectByNaming(input, indexes, "adapter", /[Aa]dapter$/);
}

function detectFacadePattern(input: PatternDetectionInput, indexes: Map<string, FileSymbolIndex>): DetectedPattern[] {
  return detectByNaming(input, indexes, "facade", /[Ff]acade$/);
}

function detectFactoryPattern(input: PatternDetectionInput, indexes: Map<string, FileSymbolIndex>): DetectedPattern[] {
  return detectByNaming(input, indexes, "factory", /[Ff]actory$/);
}

function detectSingletonPattern(input: PatternDetectionInput, indexes: Map<string, FileSymbolIndex>): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  for (const [filePath, index] of indexes) {
    for (const cls of index.classes) {
      const methods = index.methodsByContainer.get(cls.name) ?? [];
      const hasGetInstance = methods.some(
        (m) => /^getInstance$/i.test(m.name),
      );
      if (hasGetInstance) {
        patterns.push({
          name: `Singleton: ${cls.name}`,
          kind: "singleton",
          locations: [makeLocation(input.repo, filePath, cls.name)],
          confidence: 0.8,
        });
      }
    }
  }

  return patterns;
}

function detectRepositoryPattern(input: PatternDetectionInput, indexes: Map<string, FileSymbolIndex>): DetectedPattern[] {
  return detectByNaming(input, indexes, "repository", /[Rr]epo(sitory)?$/);
}

function detectMiddlewarePattern(input: PatternDetectionInput, indexes: Map<string, FileSymbolIndex>): DetectedPattern[] {
  return detectByNaming(input, indexes, "middleware", /[Mm]iddleware$/);
}

function detectObserverPattern(input: PatternDetectionInput, indexes: Map<string, FileSymbolIndex>): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  for (const [filePath, index] of indexes) {
    for (const cls of index.classes) {
      const methods = index.methodsByContainer.get(cls.name) ?? [];
      const hasSubscribe = methods.some(
        (m) => /^(subscribe|on|addEventListener|addListener)$/i.test(m.name),
      );
      const hasNotify = methods.some(
        (m) => /^(notify|emit|dispatch|publish)$/i.test(m.name),
      );
      if (hasSubscribe && hasNotify) {
        patterns.push({
          name: `Observer: ${cls.name}`,
          kind: "observer",
          locations: [makeLocation(input.repo, filePath, cls.name)],
          confidence: 0.75,
        });
      }
    }
  }

  return patterns;
}

function detectDecoratorPattern(input: PatternDetectionInput, indexes: Map<string, FileSymbolIndex>): DetectedPattern[] {
  return detectByNaming(input, indexes, "decorator", /[Dd]ecorator$/);
}

function detectBuilderPattern(input: PatternDetectionInput, indexes: Map<string, FileSymbolIndex>): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  // Detect by naming convention (XxxBuilder)
  patterns.push(...detectByNaming(input, indexes, "builder", /[Bb]uilder$/));

  // Detect by fluent interface: class with methods that return the same type + a build() method
  for (const [filePath, index] of indexes) {
    for (const cls of index.classes) {
      // Skip if already detected by naming
      if (/[Bb]uilder$/.test(cls.name)) continue;

      const methods = index.methodsByContainer.get(cls.name) ?? [];
      const hasBuild = methods.some(
        (m) => /^build$/i.test(m.name),
      );
      const hasSetters = methods.filter(
        (m) => /^(set|with|add)[A-Z]/.test(m.name),
      ).length >= 2;

      if (hasBuild && hasSetters) {
        patterns.push({
          name: `Builder: ${cls.name}`,
          kind: "builder",
          locations: [makeLocation(input.repo, filePath, cls.name)],
          confidence: 0.75,
        });
      }
    }
  }

  return patterns;
}

function detectProxyPattern(input: PatternDetectionInput, indexes: Map<string, FileSymbolIndex>): DetectedPattern[] {
  return detectByNaming(input, indexes, "proxy", /[Pp]roxy$/);
}

function detectStrategyPattern(input: PatternDetectionInput, indexes: Map<string, FileSymbolIndex>): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  // Detect by naming convention (XxxStrategy)
  patterns.push(...detectByNaming(input, indexes, "strategy", /[Ss]trategy$/));

  // Detect by structural signature: interface with a single method + multiple implementations
  for (const [filePath, index] of indexes) {
    for (const cls of index.classes) {
      const methods = index.methodsByContainer.get(cls.name) ?? [];
      // Class with execute/handle/process/apply as its primary method
      const hasStrategyMethod = methods.some(
        (m) => /^(execute|handle|process|apply|run|invoke)$/i.test(m.name),
      );
      // And the class name suggests a strategy (e.g., XxxHandler, XxxProcessor)
      const hasStrategyName = /(?:Handler|Processor|Resolver|Evaluator)$/.test(cls.name);

      if (hasStrategyMethod && hasStrategyName) {
        // Avoid duplicating if already matched by naming
        if (!/[Ss]trategy$/.test(cls.name)) {
          patterns.push({
            name: `Strategy: ${cls.name}`,
            kind: "strategy",
            locations: [makeLocation(input.repo, filePath, cls.name)],
            confidence: 0.6,
          });
        }
      }
    }
  }

  return patterns;
}

function detectByNaming(
  input: PatternDetectionInput,
  indexes: Map<string, FileSymbolIndex>,
  kind: PatternKind,
  pattern: RegExp,
): DetectedPattern[] {
  const results: DetectedPattern[] = [];

  for (const [filePath, index] of indexes) {
    for (const sym of index.classes) {
      if (pattern.test(sym.name)) {
        results.push({
          name: `${kind}: ${sym.name}`,
          kind,
          locations: [makeLocation(input.repo, filePath, sym.name)],
          confidence: 0.7,
        });
      }
    }
    for (const sym of index.interfaces) {
      if (pattern.test(sym.name)) {
        results.push({
          name: `${kind}: ${sym.name}`,
          kind,
          locations: [makeLocation(input.repo, filePath, sym.name)],
          confidence: 0.7,
        });
      }
    }
  }

  return results;
}

function makeLocation(repo: string, module: string, name: string): LogicalLocation {
  return { repo, module, fullyQualifiedName: `${module}#${name}` };
}
