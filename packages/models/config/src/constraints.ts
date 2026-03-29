/**
 * Constraint extraction from code patterns.
 *
 * Scans code for format rules, range checks, mutual exclusions,
 * guard clauses, switch dispatch, conditional defaults, and credential
 * requirements applied to feature flags, settings, and credentials.
 */

import type { FeatureConstraint, FeatureFlag, ConfigParameter } from "@mma/core";
import type { TreeSitterNode, TreeSitterTree } from "@mma/parsing";

export interface ExtractedConstraint {
  readonly flagName: string;
  readonly constraint: FeatureConstraint;
}

/**
 * Extract constraints from code patterns.
 *
 * Accepts both feature flags and config parameters. When parameters are
 * provided, the unified name set includes flags, settings, and credentials,
 * enabling cross-kind constraint detection (e.g., a setting value requiring
 * a credential to be present).
 */
export function extractConstraintsFromCode(
  files: ReadonlyMap<string, TreeSitterTree>,
  flags: readonly FeatureFlag[],
  parameters?: readonly ConfigParameter[],
): ExtractedConstraint[] {
  const constraints: ExtractedConstraint[] = [];
  const flagNames = new Set(flags.map((f) => f.name));

  // Build unified name set: flags + settings + credentials
  const allNames = new Set(flagNames);
  if (parameters) {
    for (const p of parameters) {
      allNames.add(p.name);
    }
  }

  // Build parameter lookup for kind classification
  const paramKindMap = new Map<string, "setting" | "credential" | "flag">();
  for (const f of flags) paramKindMap.set(f.name, "flag");
  if (parameters) {
    for (const p of parameters) paramKindMap.set(p.name, p.kind);
  }

  for (const [_filePath, tree] of files) {
    // Look for if-else chains that check multiple flags/parameters
    const ifChains = findFlagIfChains(tree.rootNode, allNames);
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
    const validations = findValidationPatterns(tree.rootNode, allNames);
    constraints.push(...validations);

    // Look for guard clauses: if (param === value) { require(other) }
    const guardConstraints = findGuardClauses(tree.rootNode, allNames);
    constraints.push(...guardConstraints);

    // Look for switch dispatch: switch (param) { case 'a': ... case 'b': ... }
    const switchConstraints = findSwitchDispatch(tree.rootNode, allNames);
    constraints.push(...switchConstraints);

    // Look for conditional defaults: param = condition ? value1 : value2
    const conditionalConstraints = findConditionalDefaults(tree.rootNode, allNames);
    constraints.push(...conditionalConstraints);
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

function escapeRegExpFlag(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findFlagReference(
  node: TreeSitterNode,
  flagNames: Set<string>,
): string | null {
  const text = node.text;
  for (const name of flagNames) {
    const re = new RegExp(`\\b${escapeRegExpFlag(name)}\\b`);
    if (re.test(text)) return name;
  }
  return null;
}

/**
 * Extract the string value from an equality comparison.
 * Given `param === "value"` or `param === 'value'`, returns the string literal.
 */
function extractComparisonValue(node: TreeSitterNode): string | null {
  if (node.type !== "binary_expression") return null;

  const operator = node.children.find((c) =>
    ["===", "==", "!==", "!="].includes(c.text),
  );
  if (!operator || operator.text === "!==" || operator.text === "!=") return null;

  // Find the string literal child
  for (const child of node.namedChildren) {
    if (child.type === "string") {
      return child.text.replace(/['"]/g, "");
    }
  }
  return null;
}

/**
 * Detect guard clauses: if (param === 'value') { ...uses otherParam... }
 *
 * Pattern: an if-statement with an equality check on a known parameter,
 * whose body references another known parameter. This implies:
 * param=value requires otherParam.
 */
function findGuardClauses(
  node: TreeSitterNode,
  allNames: Set<string>,
): ExtractedConstraint[] {
  const constraints: ExtractedConstraint[] = [];

  visitAll(node, (n) => {
    if (n.type !== "if_statement") return;

    // Get the condition (first named child or parenthesized_expression)
    const condition = n.namedChildren.find(
      (c) => c.type === "parenthesized_expression" || c.type === "binary_expression",
    );
    if (!condition) return;

    // Find the binary expression inside (may be wrapped in parens)
    const binaryExpr = condition.type === "parenthesized_expression"
      ? findFirstOfType(condition, "binary_expression")
      : condition;
    if (!binaryExpr) return;

    // Check if condition is an equality check on a known parameter
    const guardParam = findFlagReference(binaryExpr, allNames);
    if (!guardParam) return;

    const comparisonValue = extractComparisonValue(binaryExpr);
    if (!comparisonValue) return;

    // Find the if body (statement_block)
    const body = n.namedChildren.find((c) => c.type === "statement_block");
    if (!body) return;

    // Check if body references another known parameter
    const bodyText = body.text;
    for (const name of allNames) {
      if (name === guardParam) continue;
      const re = new RegExp(`\\b${escapeRegExpFlag(name)}\\b`);
      if (re.test(bodyText)) {
        constraints.push({
          flagName: guardParam,
          constraint: {
            kind: "requires",
            flags: [guardParam, name],
            description: `Guard clause: ${guardParam}="${comparisonValue}" requires ${name}`,
            source: "inferred",
            condition: { [guardParam]: comparisonValue },
          },
        });
      }
    }
  });

  return constraints;
}

/**
 * Detect switch dispatch: switch (param) { case 'a': ... case 'b': ... }
 *
 * Produces an enum constraint listing the allowed values, and a mutex
 * constraint over the cases.
 */
function findSwitchDispatch(
  node: TreeSitterNode,
  allNames: Set<string>,
): ExtractedConstraint[] {
  const constraints: ExtractedConstraint[] = [];

  visitAll(node, (n) => {
    if (n.type !== "switch_statement") return;

    // Find the switch expression
    const switchExpr = n.namedChildren.find(
      (c) => c.type === "parenthesized_expression",
    );
    if (!switchExpr) return;

    const switchParam = findFlagReference(switchExpr, allNames);
    if (!switchParam) return;

    // Find the switch body
    const body = n.namedChildren.find((c) => c.type === "switch_body");
    if (!body) return;

    // Extract case values
    const caseValues: string[] = [];
    for (const child of body.namedChildren) {
      if (child.type === "switch_case") {
        // First named child is the case value expression
        const caseExpr = child.namedChildren[0];
        if (caseExpr?.type === "string") {
          caseValues.push(caseExpr.text.replace(/['"]/g, ""));
        }
      }
    }

    if (caseValues.length >= 2) {
      constraints.push({
        flagName: switchParam,
        constraint: {
          kind: "enum",
          flags: [switchParam],
          description: `Switch dispatch: ${switchParam} must be one of [${caseValues.join(", ")}]`,
          source: "inferred",
          allowedValues: caseValues,
        },
      });
    }
  });

  return constraints;
}

/**
 * Detect conditional defaults: param = condition ? value1 : value2
 *
 * When a ternary expression assigns different values to a known parameter
 * based on a condition that references another known parameter, this
 * creates a conditional constraint.
 */
function findConditionalDefaults(
  node: TreeSitterNode,
  allNames: Set<string>,
): ExtractedConstraint[] {
  const constraints: ExtractedConstraint[] = [];

  visitAll(node, (n) => {
    if (n.type !== "ternary_expression") return;

    const children = n.namedChildren;
    if (children.length < 3) return;

    const condition = children[0]!;
    const consequent = children[1]!;
    const alternate = children[2]!;

    // Check if condition references a known parameter
    const condParam = findFlagReference(condition, allNames);
    if (!condParam) return;

    // Check if consequence or alternate are literals
    const consValue = extractNodeLiteralValue(consequent);
    const altValue = extractNodeLiteralValue(alternate);
    if (consValue === null && altValue === null) return;

    // Look for the assignment target — walk up to find variable_declarator or assignment_expression
    const assignTarget = findAssignmentTarget(node, n);
    if (!assignTarget) return;

    // Check if the assigned variable is also a known parameter
    const targetParam = findFlagReference(
      { text: assignTarget, type: "identifier", namedChildren: [], children: [] } as unknown as TreeSitterNode,
      allNames,
    );

    if (targetParam && targetParam !== condParam) {
      const allowedValues = [consValue, altValue].filter((v) => v !== null);
      constraints.push({
        flagName: condParam,
        constraint: {
          kind: "conditional",
          flags: [condParam, targetParam],
          description: `Conditional default: ${condParam} constrains ${targetParam} to ${JSON.stringify(allowedValues)}`,
          source: "inferred",
          condition: { [condParam]: true },
          allowedValues,
        },
      });
    }
  });

  return constraints;
}

/**
 * Extract a literal value from a tree-sitter node.
 */
function extractNodeLiteralValue(node: TreeSitterNode): unknown {
  if (node.type === "number") return parseFloat(node.text);
  if (node.type === "string") return node.text.replace(/['"]/g, "");
  if (node.type === "true" || node.text === "true") return true;
  if (node.type === "false" || node.text === "false") return false;
  return null;
}

/**
 * Walk up from a ternary_expression to find what variable it's assigned to.
 * Looks for variable_declarator or assignment_expression parent patterns.
 */
function findAssignmentTarget(root: TreeSitterNode, target: TreeSitterNode): string | null {
  let result: string | null = null;

  function search(node: TreeSitterNode): boolean {
    for (const child of node.namedChildren) {
      if (child === target) {
        // Check if this node is a variable_declarator or assignment_expression
        if (node.type === "variable_declarator") {
          const name = node.namedChildren[0];
          if (name?.type === "identifier") result = name.text;
        } else if (node.type === "assignment_expression") {
          const lhs = node.namedChildren[0];
          if (lhs) result = lhs.text;
        }
        return true;
      }
      if (search(child)) return true;
    }
    return false;
  }

  search(root);
  return result;
}

/**
 * Find the first descendant node of a given type.
 */
function findFirstOfType(node: TreeSitterNode, type: string): TreeSitterNode | null {
  if (node.type === type) return node;
  for (const child of node.namedChildren) {
    const found = findFirstOfType(child, type);
    if (found) return found;
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
      // Operator tokens (<, >, <=, >=) are UNNAMED children in tree-sitter's
      // TypeScript grammar. Use node.children (all children) instead of
      // namedChildren to detect them.
      const operator = n.children.find((c) =>
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
