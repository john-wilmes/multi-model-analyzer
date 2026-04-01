// credential-access-extractor.ts — tree-sitter-based ISC credential access extractor
import { initTreeSitter, parseSource } from "@mma/parsing";
import type { TreeSitterNode } from "@mma/parsing";
import type {
  AccessKind,
  CredentialAccess,
  CredentialAccessResult,
  GuardCondition,
} from "./types.js";

// ─── Credential chain detection ───────────────────────────────────────────────

const CREDENTIALS_CHAIN_PREFIXES = [
  "self.options.integrator.credentials.",
  "this.options.integrator.credentials.",
];

/** Returns true if the text is a full credentials chain root (ends at .credentials) */
function isCredentialsChainRoot(text: string): boolean {
  return (
    text === "self.options.integrator.credentials" ||
    text === "this.options.integrator.credentials" ||
    text === "this.credentials"
  );
}

/** Extract the field name from a member expression that accesses a credential field.
 * Returns null if this node doesn't represent a credential access. */
function extractCredentialField(
  nodeText: string,
  aliases: Set<string>,
): { field: string; pattern: string } | null {
  // Pattern 1 & 2: self/this.options.integrator.credentials.fieldName
  for (const prefix of CREDENTIALS_CHAIN_PREFIXES) {
    if (nodeText.startsWith(prefix)) {
      const rest = nodeText.slice(prefix.length);
      // Avoid matching the chain root itself (no field after credentials)
      if (rest.length === 0) return null;
      // Preserve the full dotted path (e.g., "oauth.clientId" not just "oauth")
      if (rest.length > 0) {
        return {
          field: rest,
          pattern:
            prefix === "self.options.integrator.credentials."
              ? "self.options.integrator.credentials"
              : "this.options.integrator.credentials",
        };
      }
    }
  }

  // Pattern 6: this.credentials.fieldName (but not this.options.integrator.credentials)
  const thisCredPrefix = "this.credentials.";
  if (
    nodeText.startsWith(thisCredPrefix) &&
    !nodeText.startsWith("this.credentials.options")
  ) {
    const rest = nodeText.slice(thisCredPrefix.length);
    // Preserve the full dotted path
    if (rest.length > 0) {
      return { field: rest, pattern: "this.credentials" };
    }
  }

  // Alias pattern: aliasName.fieldName
  for (const alias of aliases) {
    const aliasPrefix = alias + ".";
    if (nodeText.startsWith(aliasPrefix)) {
      const rest = nodeText.slice(aliasPrefix.length);
      // Preserve the full dotted path; skip if it contains a call expression
      if (rest.length > 0 && !rest.includes("(")) {
        return { field: rest, pattern: "self.options.integrator.credentials" };
      }
    }
  }

  return null;
}

// ─── Guard condition extraction ───────────────────────────────────────────────

/** Walk up the AST from a node, collecting enclosing if_statement conditions. */
function extractGuardConditions(
  node: TreeSitterNode,
  aliases: Set<string>,
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
        const guard = parseGuardCondition(condition.text, inElse, aliases);
        if (guard) {
          guards.push(guard);
        }
      }
    }

    current = current.parent;
  }

  return guards;
}

/** Parse a condition text to extract guard information about a credential field. */
function parseGuardCondition(
  condText: string,
  negated: boolean,
  aliases: Set<string>,
): GuardCondition | null {
  const trimmed = condText.trim();

  // Check for negation: !credentials.field or !(credentials.field)
  if (trimmed.startsWith("!") && !trimmed.startsWith("!=")) {
    const inner = trimmed.slice(1).replace(/^\(|\)$/g, "");
    return parseGuardCondition(inner, !negated, aliases);
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
      const guard = parseGuardCondition(part.trim(), negated, aliases);
      if (guard) return guard;
    }
  }

  // Check for logical OR first (before equality) for the same reason
  if (trimmed.includes(" || ")) {
    const parts = trimmed.split(" || ");
    for (const part of parts) {
      const guard = parseGuardCondition(part.trim(), negated, aliases);
      if (guard) return guard;
    }
  }

  // Check for typeof: typeof credentials.field === 'string' or !==
  const typeofMatch = trimmed.match(/^typeof\s+(\S+)\s*(===?|!==?)\s*['"](\w+)['"]/);
  if (typeofMatch) {
    const subject = typeofMatch[1]!;
    const op = typeofMatch[2]!;
    const fieldInfo = extractCredentialField(subject, aliases);
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
    const fieldInfo = extractCredentialField(lhs, aliases);
    if (fieldInfo) {
      return {
        field: fieldInfo.field,
        operator: op === "===" || op === "==" ? "==" : "!=",
        value: rhs,
        negated,
      };
    }
    // Also check rhs === lhs (value on left)
    const rhsField = extractCredentialField(rhs, aliases);
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
  const fieldInfo = extractCredentialField(trimmed, aliases);
  if (fieldInfo) {
    return { field: fieldInfo.field, operator: "truthy", negated };
  }

  return null;
}

// ─── Access kind detection ─────────────────────────────────────────────────────

/** Determine if a node is on the left side of an assignment */
function isOnAssignmentLeft(node: TreeSitterNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "assignment_expression") {
    const left = parent.children[0];
    return left !== null && left !== undefined && left.id === node.id;
  }
  return false;
}

/** Detect if a node has a default fallback (|| or ??) parent on its left side */
function hasDefaultFallback(node: TreeSitterNode): boolean {
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

// ─── AST walker ───────────────────────────────────────────────────────────────

interface FileAccess {
  accesses: CredentialAccess[];
  byPattern: Record<string, number>;
}

function processFile(filePath: string, root: TreeSitterNode): FileAccess {
  const accesses: CredentialAccess[] = [];
  const byPattern: Record<string, number> = {};

  // Credential aliases found in this file (variable names that hold credentials object)
  const aliases = new Set<string>(["credentials"]);
  const aliasPatterns = new Map<string, string>();

  // First pass: collect variable aliases for credential objects.
  // Known limitation: alias collection is file-scoped (not block-scoped), so a shadowed local
  // variable that reuses a credential alias name will be incorrectly treated as a credential alias.
  // This causes over-reporting (false positives) rather than under-reporting, which is the safe
  // direction for static analysis — we'd rather flag too many fields than miss a required one.
  collectAliases(root, aliases, aliasPatterns);

  // Second pass: walk and extract accesses
  walkNode(root, filePath, aliases, aliasPatterns, accesses, byPattern);

  return { accesses, byPattern };
}

/** Collect credential aliases from variable declarations */
function collectAliases(
  node: TreeSitterNode,
  aliases: Set<string>,
  aliasPatterns: Map<string, string>,
): void {
  if (node.type === "variable_declarator") {
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (nameNode && valueNode) {
      const valueText = valueNode.text.trim();
      if (isCredentialsChainRoot(valueText)) {
        const alias = nameNode.text.trim();
        if (alias && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(alias)) {
          aliases.add(alias);
          const pattern = valueText.startsWith("this.credentials")
            ? "this.credentials"
            : valueText.includes("self.")
              ? "self.options.integrator.credentials"
              : "this.options.integrator.credentials";
          aliasPatterns.set(alias, pattern);
        }
      }
    }
  }

  for (const child of node.children) {
    collectAliases(child, aliases, aliasPatterns);
  }
}

/** Walk AST nodes to find credential accesses */
function walkNode(
  node: TreeSitterNode,
  filePath: string,
  aliases: Set<string>,
  aliasPatterns: Map<string, string>,
  accesses: CredentialAccess[],
  byPattern: Record<string, number>,
): void {
  // Pattern 5: _.get(credentials, 'field', default) or _.get(creds, 'field')
  if (node.type === "call_expression") {
    const fn = node.namedChildren[0];
    if (fn && (fn.text === "_.get" || fn.text === "lodash.get")) {
      const argList = node.namedChildren.find((c) => c.type === "arguments");
      if (argList) {
        const callArgs = argList.namedChildren;
        const firstArg = callArgs[0];
        const secondArg = callArgs[1];
        const thirdArg = callArgs[2];

        if (firstArg && secondArg) {
          const firstText = firstArg.text.trim();
          const isCredentials =
            aliases.has(firstText) ||
            isCredentialsChainRoot(firstText) ||
            CREDENTIALS_CHAIN_PREFIXES.some((p) =>
              firstText === p.slice(0, -1),
            );

          if (isCredentials) {
            let field: string | null = null;
            if (secondArg.type === "string") {
              field = secondArg.text.slice(1, -1);
            } else if (secondArg.type === "template_string") {
              const inner = secondArg.text.slice(1, -1);
              // Skip template strings with interpolations — they produce dynamic keys
              if (!inner.includes("${")) {
                field = inner;
              }
            }

            if (field !== null && field.length > 0) {
              const hasDefault = thirdArg !== undefined && thirdArg !== null;
              const accessKind: AccessKind = hasDefault ? "default-fallback" : "read";
              const guards = extractGuardConditions(node, aliases);
              const line = node.startPosition.row + 1;

              accesses.push({
                field,
                file: filePath,
                line,
                accessKind,
                hasDefault,
                guardConditions: guards,
              });
              byPattern["lodash-get"] = (byPattern["lodash-get"] ?? 0) + 1;
            }
          }
        }
      }
    }
  }

  // Pattern 4: Destructuring from credentials chain
  if (node.type === "variable_declarator") {
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (nameNode && valueNode && nameNode.type === "object_pattern") {
      const valueText = valueNode.text.trim();
      const isCredentialsSource =
        isCredentialsChainRoot(valueText) ||
        aliases.has(valueText) ||
        CREDENTIALS_CHAIN_PREFIXES.some((p) => valueText === p.slice(0, -1));

      if (isCredentialsSource) {
        for (const prop of nameNode.namedChildren) {
          let fieldName: string | null = null;
          if (prop.type === "shorthand_property_identifier_pattern") {
            fieldName = prop.text;
          } else if (prop.type === "pair_pattern") {
            const keyNode = prop.children[0];
            if (keyNode) {
              fieldName = keyNode.text.replace(/^["']|["']$/g, "");
            }
          } else if (prop.type === "identifier") {
            fieldName = prop.text;
          }

          if (fieldName && fieldName.length > 0) {
            const guards = extractGuardConditions(node, aliases);
            const line = node.startPosition.row + 1;
            accesses.push({
              field: fieldName,
              file: filePath,
              line,
              accessKind: "read",
              hasDefault: false,
              guardConditions: guards,
            });
            byPattern["destructuring"] = (byPattern["destructuring"] ?? 0) + 1;
          }
        }
      }
    }
  }

  // Pattern 1, 2, 6, alias: member_expression
  if (node.type === "member_expression") {
    const nodeText = node.text.trim();
    const fieldInfo = extractCredentialField(nodeText, aliases);

    if (fieldInfo) {
      // Avoid double-counting: only process the "deepest" matching expression
      // i.e., skip if parent is also a member_expression that would also match
      const parentText = node.parent?.text.trim() ?? "";
      const parentMatches =
        node.parent?.type === "member_expression" &&
        extractCredentialField(parentText, aliases) !== null;

      if (!parentMatches) {
        const line = node.startPosition.row + 1;

        let accessKind: AccessKind = "read";
        if (isOnAssignmentLeft(node)) {
          accessKind = "write";
        } else if (hasDefaultFallback(node)) {
          accessKind = "default-fallback";
        }

        const hasDefault = accessKind === "default-fallback";
        const guards = extractGuardConditions(node, aliases);
        const resolvedPattern = aliasPatterns.get(nodeText.split(".")[0] ?? "") ?? fieldInfo.pattern;

        accesses.push({
          field: fieldInfo.field,
          file: filePath,
          line,
          accessKind,
          hasDefault,
          guardConditions: guards,
        });
        byPattern[resolvedPattern] = (byPattern[resolvedPattern] ?? 0) + 1;
      }
    }
  }

  for (const child of node.children) {
    walkNode(child, filePath, aliases, aliasPatterns, accesses, byPattern);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function extractCredentialAccesses(
  files: { path: string; content: string }[],
): Promise<CredentialAccessResult> {
  await initTreeSitter();

  const allAccesses: CredentialAccess[] = [];
  const errors: { file: string; error: string }[] = [];
  const totalByPattern: Record<string, number> = {};
  let filesWithAccesses = 0;

  for (const { path, content } of files) {
    let tree;
    try {
      tree = parseSource(content, path);
      const result = processFile(path, tree.rootNode);
      const { accesses, byPattern } = result;

      if (accesses.length > 0) {
        filesWithAccesses++;
        allAccesses.push(...accesses);
        for (const [pattern, count] of Object.entries(byPattern)) {
          totalByPattern[pattern] = (totalByPattern[pattern] ?? 0) + count;
        }
      }
    } catch (err) {
      errors.push({
        file: path,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      tree?.delete();
    }
  }

  return {
    accesses: allAccesses,
    errors,
    stats: {
      filesScanned: files.length,
      filesWithAccesses,
      totalAccesses: allAccesses.length,
      byPattern: totalByPattern,
    },
  };
}
