// ast-utils.ts — shared AST utilities for constraint extraction
import type { TreeSitterNode } from "@mma/parsing";
import type { GuardCondition } from "./types.js";

/** Callback that extracts a field name from a member expression text */
export type FieldExtractor = (text: string) => { field: string } | null;

/** Determine if a node is on the left side of an assignment */
export function isOnAssignmentLeft(node: TreeSitterNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "assignment_expression") {
    const left = parent.children[0];
    return left !== null && left !== undefined && left.id === node.id;
  }
  return false;
}

/** Detect if a node has a default fallback (|| or ??) parent on its left side */
export function hasDefaultFallback(node: TreeSitterNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "binary_expression") {
    const op = parent.children[1];
    if (op && (op.text === "||" || op.text === "??")) {
      const left = parent.children[0];
      if (left !== null && left !== undefined && left.id === node.id) return true;
    }
  }
  return false;
}

/** Parse a condition text to extract guard information about a credential field. */
export function parseGuardCondition(
  condText: string,
  negated: boolean,
  fieldExtractor: FieldExtractor,
): GuardCondition | null {
  const trimmed = condText.trim();

  // Check for negation: !credentials.field or !(credentials.field)
  if (trimmed.startsWith("!") && !trimmed.startsWith("!=")) {
    const inner = trimmed.slice(1).replace(/^\(|\)$/g, "");
    return parseGuardCondition(inner, !negated, fieldExtractor);
  }

  // Check for logical AND first (before equality) to prevent greedy regex from consuming compound expressions
  // Known limitation: splitting on " && " / " || " is whitespace-sensitive and returns only the first
  // matching sub-expression rather than combining all guards into a conjunction/disjunction.
  // typeof negation via "!==" in compound guards also doesn't propagate the negated flag correctly.
  // Production impact is minimal because tree-sitter-extracted guards are consistently well-formatted,
  // but complex multi-clause guards will be partially captured at best.
  if (trimmed.includes(" && ")) {
    const parts = trimmed.split(" && ");
    for (const part of parts) {
      const guard = parseGuardCondition(part.trim(), negated, fieldExtractor);
      if (guard) return guard;
    }
  }

  // Check for logical OR first (before equality) for the same reason
  if (trimmed.includes(" || ")) {
    const parts = trimmed.split(" || ");
    for (const part of parts) {
      const guard = parseGuardCondition(part.trim(), negated, fieldExtractor);
      if (guard) return guard;
    }
  }

  // Check for typeof: typeof credentials.field === 'string' or !==
  const typeofMatch = trimmed.match(/^typeof\s+(\S+)\s*(===?|!==?)\s*['"](\w+)['"]/);
  if (typeofMatch) {
    const subject = typeofMatch[1]!;
    const op = typeofMatch[2]!;
    const fieldInfo = fieldExtractor(subject);
    if (fieldInfo) {
      // Flip negated if the operator is !== or !=
      const isNegatingOp = op === "!==" || op === "!=";
      return {
        field: fieldInfo.field,
        operator: "typeof",
        value: typeofMatch[3],
        negated: isNegatingOp ? !negated : negated,
      };
    }
  }

  // Check for equality: credentials.field === 'value' or credentials.field !== 'value'
  // Use a non-greedy RHS that stops at quotes to avoid consuming compound expressions
  const eqMatch = trimmed.match(/^(\S+)\s*(===?|!==?)\s*(['"]?)([^'"&|]*)\3\s*$/);
  if (eqMatch) {
    const lhs = eqMatch[1]!;
    const op = eqMatch[2]!;
    const rhs = eqMatch[4]!.trim();
    const fieldInfo = fieldExtractor(lhs);
    if (fieldInfo) {
      return {
        field: fieldInfo.field,
        operator: op === "===" || op === "==" ? "==" : "!=",
        value: rhs,
        negated,
      };
    }
    // Also check rhs === lhs (value on left)
    const rhsField = fieldExtractor(rhs);
    if (rhsField) {
      return {
        field: rhsField.field,
        operator: op === "===" || op === "==" ? "==" : "!=",
        value: lhs,
        negated,
      };
    }
  }

  // Truthy/falsy check: just the credential field itself
  const fieldInfo = fieldExtractor(trimmed);
  if (fieldInfo) {
    return { field: fieldInfo.field, operator: "truthy", negated };
  }

  return null;
}

/** Like extractGuardConditions but also returns raw text of unmatched conditions. */
export function extractGuardConditionsExt(
  node: TreeSitterNode,
  fieldExtractor: FieldExtractor,
): { guards: GuardCondition[]; rawUnmatched: string[] } {
  const guards: GuardCondition[] = [];
  const rawUnmatched: string[] = [];
  let current: TreeSitterNode | null = node.parent;

  while (current !== null) {
    if (
      current.type === "function_declaration" ||
      current.type === "function" ||
      current.type === "arrow_function" ||
      current.type === "method_definition" ||
      current.type === "class_body"
    ) {
      break;
    }

    if (current.type === "if_statement") {
      const alternative = current.namedChildren.find((c) => c.type === "else_clause");
      let inElse = false;
      if (alternative) {
        let ancestor: TreeSitterNode | null = node;
        while (ancestor !== null && ancestor.id !== current.id) {
          if (ancestor.id === alternative.id) {
            inElse = true;
            break;
          }
          ancestor = ancestor.parent;
        }
      }

      let condition = current.childForFieldName("condition") ?? current.namedChildren[0];
      if (condition && condition.type !== "statement_block") {
        if (condition.type === "parenthesized_expression") {
          condition = condition.namedChildren[0] ?? condition;
        }
        const guard = parseGuardCondition(condition.text, inElse, fieldExtractor);
        if (guard) {
          guards.push(guard);
        } else {
          rawUnmatched.push(condition.text);
        }
      }
    }

    current = current.parent;
  }

  return { guards, rawUnmatched };
}

/** Walk up the AST from a node, collecting enclosing if_statement conditions. */
export function extractGuardConditions(
  node: TreeSitterNode,
  fieldExtractor: FieldExtractor,
): GuardCondition[] {
  const guards: GuardCondition[] = [];
  let current: TreeSitterNode | null = node.parent;

  while (current !== null) {
    // Stop at function boundaries
    if (
      current.type === "function_declaration" ||
      current.type === "function" ||
      current.type === "arrow_function" ||
      current.type === "method_definition" ||
      current.type === "class_body"
    ) {
      break;
    }

    if (current.type === "if_statement") {
      // Determine if this node is inside the else branch
      const alternative = current.namedChildren.find((c) => c.type === "else_clause");
      let inElse = false;
      if (alternative) {
        let ancestor: TreeSitterNode | null = node;
        while (ancestor !== null && ancestor.id !== current.id) {
          if (ancestor.id === alternative.id) {
            inElse = true;
            break;
          }
          ancestor = ancestor.parent;
        }
      }

      // Use the named "condition" field if available, else fall back to first named child
      let condition = current.childForFieldName("condition") ?? current.namedChildren[0];
      if (condition && condition.type !== "statement_block") {
        // Unwrap parenthesized_expression: (expr) -> expr
        if (condition.type === "parenthesized_expression") {
          condition = condition.namedChildren[0] ?? condition;
        }
        const guard = parseGuardCondition(condition.text, inElse, fieldExtractor);
        if (guard) {
          guards.push(guard);
        }
      }
    }

    current = current.parent;
  }

  return guards;
}
