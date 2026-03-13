/**
 * Constraint extraction from code patterns.
 *
 * Scans code for format rules, range checks, mutual exclusions,
 * and other constraint patterns applied to feature flags.
 */

import type { FeatureConstraint, FeatureFlag } from "@mma/core";
import type { TreeSitterNode, TreeSitterTree } from "@mma/parsing";

export interface ExtractedConstraint {
  readonly flagName: string;
  readonly constraint: FeatureConstraint;
}

export function extractConstraintsFromCode(
  files: ReadonlyMap<string, TreeSitterTree>,
  flags: readonly FeatureFlag[],
): ExtractedConstraint[] {
  const constraints: ExtractedConstraint[] = [];
  const flagNames = new Set(flags.map((f) => f.name));

  for (const [_filePath, tree] of files) {
    // Look for if-else chains that check multiple flags
    const ifChains = findFlagIfChains(tree.rootNode, flagNames);
    for (const chain of ifChains) {
      if (chain.length >= 2) {
        constraints.push({
          flagName: chain[0]!,
          constraint: {
            kind: "mutex",
            flags: chain,
            description: "Mutually exclusive in if-else chain",
            source: "inferred",
          },
        });
      }
    }

    // Look for validation patterns (range checks, format checks)
    const validations = findValidationPatterns(tree.rootNode, flagNames);
    constraints.push(...validations);
  }

  return constraints;
}

function findFlagIfChains(
  node: TreeSitterNode,
  flagNames: Set<string>,
): string[][] {
  const chains: string[][] = [];

  visitAll(node, (n) => {
    if (n.type !== "if_statement") return;

    const chain: string[] = [];
    let current: TreeSitterNode | undefined = n;

    while (current?.type === "if_statement") {
      const condition = current.namedChildren.find(
        (c) => c.type === "parenthesized_expression" || c.type === "binary_expression",
      );
      if (condition) {
        const flagRef = findFlagReference(condition, flagNames);
        if (flagRef) chain.push(flagRef);
      }

      // Move to else-if
      const elseClause: TreeSitterNode | undefined = current.namedChildren.find((c: TreeSitterNode) => c.type === "else_clause");
      current = elseClause?.namedChildren.find((c: TreeSitterNode) => c.type === "if_statement");
    }

    if (chain.length >= 2) {
      chains.push(chain);
    }
  });

  return chains;
}

function findFlagReference(
  node: TreeSitterNode,
  flagNames: Set<string>,
): string | null {
  const text = node.text;
  for (const name of flagNames) {
    if (text.includes(name)) return name;
  }
  return null;
}

function findValidationPatterns(
  node: TreeSitterNode,
  flagNames: Set<string>,
): ExtractedConstraint[] {
  const constraints: ExtractedConstraint[] = [];

  visitAll(node, (n) => {
    // Pattern: if (flagValue < MIN || flagValue > MAX)
    if (n.type === "binary_expression") {
      const operator = n.namedChildren.find((c) =>
        ["<", ">", "<=", ">="].includes(c.text),
      );
      if (operator) {
        const flagRef = findFlagReference(n, flagNames);
        if (flagRef) {
          constraints.push({
            flagName: flagRef,
            constraint: {
              kind: "range",
              flags: [flagRef],
              description: `Range check detected: ${n.text.slice(0, 50)}`,
              source: "inferred",
            },
          });
        }
      }
    }
  });

  return constraints;
}

function visitAll(
  node: TreeSitterNode,
  visitor: (n: TreeSitterNode) => void,
): void {
  visitor(node);
  for (const child of node.namedChildren) {
    visitAll(child, visitor);
  }
}
