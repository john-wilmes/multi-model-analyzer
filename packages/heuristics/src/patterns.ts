/**
 * Architectural pattern detection from structural signatures.
 *
 * Identifies common patterns (adapter, facade, observer, factory, etc.)
 * by analyzing class/interface hierarchies, naming conventions, and
 * dependency structures.
 */

import type { DetectedPattern, LogicalLocation, PatternKind, SymbolInfo } from "@mma/core";

export interface PatternDetectionInput {
  readonly repo: string;
  readonly symbols: ReadonlyMap<string, readonly SymbolInfo[]>;
  readonly imports: ReadonlyMap<string, readonly string[]>;
}

interface PatternRule {
  readonly kind: PatternKind;
  readonly detect: (input: PatternDetectionInput) => DetectedPattern[];
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
];

export function detectPatterns(input: PatternDetectionInput): DetectedPattern[] {
  const results: DetectedPattern[] = [];
  for (const rule of PATTERN_RULES) {
    results.push(...rule.detect(input));
  }
  return results;
}

function detectAdapterPattern(input: PatternDetectionInput): DetectedPattern[] {
  return detectByNaming(input, "adapter", /[Aa]dapter$/);
}

function detectFacadePattern(input: PatternDetectionInput): DetectedPattern[] {
  return detectByNaming(input, "facade", /[Ff]acade$/);
}

function detectFactoryPattern(input: PatternDetectionInput): DetectedPattern[] {
  return detectByNaming(input, "factory", /[Ff]actory$/);
}

function detectSingletonPattern(input: PatternDetectionInput): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  for (const [filePath, symbols] of input.symbols) {
    const classes = symbols.filter((s) => s.kind === "class");
    for (const cls of classes) {
      const methods = symbols.filter(
        (s) => s.kind === "method" && s.containerName === cls.name,
      );
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

function detectRepositoryPattern(input: PatternDetectionInput): DetectedPattern[] {
  return detectByNaming(input, "repository", /[Rr]epo(sitory)?$/);
}

function detectMiddlewarePattern(input: PatternDetectionInput): DetectedPattern[] {
  return detectByNaming(input, "middleware", /[Mm]iddleware$/);
}

function detectObserverPattern(input: PatternDetectionInput): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  for (const [filePath, symbols] of input.symbols) {
    const classes = symbols.filter((s) => s.kind === "class");
    for (const cls of classes) {
      const methods = symbols.filter(
        (s) => s.kind === "method" && s.containerName === cls.name,
      );
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

function detectDecoratorPattern(input: PatternDetectionInput): DetectedPattern[] {
  return detectByNaming(input, "decorator", /[Dd]ecorator$/);
}

function detectByNaming(
  input: PatternDetectionInput,
  kind: PatternKind,
  pattern: RegExp,
): DetectedPattern[] {
  const results: DetectedPattern[] = [];

  for (const [filePath, symbols] of input.symbols) {
    const matches = symbols.filter(
      (s) => (s.kind === "class" || s.kind === "interface") && pattern.test(s.name),
    );
    for (const sym of matches) {
      results.push({
        name: `${kind}: ${sym.name}`,
        kind,
        locations: [makeLocation(input.repo, filePath, sym.name)],
        confidence: 0.7,
      });
    }
  }

  return results;
}

function makeLocation(repo: string, module: string, name: string): LogicalLocation {
  return { repo, module, fullyQualifiedName: `${module}#${name}` };
}
