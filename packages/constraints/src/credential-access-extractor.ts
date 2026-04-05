// credential-access-extractor.ts — tree-sitter-based ISC credential access extractor
import { initTreeSitter, parseSource } from "@mma/parsing";
import type { TreeSitterNode } from "@mma/parsing";
import type {
  AccessKind,
  CredentialAccess,
  CredentialAccessResult,
} from "./types.js";
import {
  extractGuardConditionsExt,
  findEnclosingFunction,
  hasDefaultFallback,
  isOnAssignmentLeft,
  type FieldExtractor,
} from "./ast-utils.js";

// ─── Credential chain detection ───────────────────────────────────────────────

const CREDENTIALS_CHAIN_PREFIXES = [
  "self.options.integrator.credentials.",
  "this.options.integrator.credentials.",
];

/** Returns true if the text is a full credentials chain root (ends at .credentials) */
function isCredentialsChainRoot(text: string): boolean {
  const normalized = text.replace(/\?\./g, '.');
  return (
    normalized === "self.options.integrator.credentials" ||
    normalized === "this.options.integrator.credentials" ||
    normalized === "this.credentials"
  );
}

/** Extract the field name from a member expression that accesses a credential field.
 * Returns null if this node doesn't represent a credential access. */
function extractCredentialField(
  nodeText: string,
  aliases: Set<string>,
): { field: string; pattern: string } | null {
  // Normalize optional chaining before any prefix matching so that
  // `self.options.integrator.credentials?.foo` matches the same as
  // `self.options.integrator.credentials.foo`.
  const normalizedText = nodeText.replace(/\?\./g, '.');

  // Pattern 1 & 2: self/this.options.integrator.credentials.fieldName
  for (const prefix of CREDENTIALS_CHAIN_PREFIXES) {
    if (normalizedText.startsWith(prefix)) {
      const rest = normalizedText.slice(prefix.length);
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
    normalizedText.startsWith(thisCredPrefix) &&
    !normalizedText.startsWith("this.credentials.options")
  ) {
    const rest = normalizedText.slice(thisCredPrefix.length);
    // Preserve the full dotted path
    if (rest.length > 0) {
      return { field: rest, pattern: "this.credentials" };
    }
  }

  // Alias pattern: aliasName.fieldName
  for (const alias of aliases) {
    const aliasPrefix = alias + ".";
    if (normalizedText.startsWith(aliasPrefix)) {
      const rest = normalizedText.slice(aliasPrefix.length);
      // Preserve the full dotted path; skip if it contains a call expression
      if (rest.length > 0 && !rest.includes("(")) {
        return { field: rest, pattern: "self.options.integrator.credentials" };
      }
    }
  }

  return null;
}

// ─── Access kind detection ─────────────────────────────────────────────────────

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

/** Returns true if the text is an integrator object reference (one hop before .credentials) */
function isIntegratorRoot(text: string): boolean {
  const normalized = text.replace(/\?\./g, '.');
  return (
    normalized === "self.options.integrator" ||
    normalized === "this.options.integrator"
  );
}

/** Collect credential aliases from variable declarations.
 *  Supports two-hop chains like:
 *    var integrator = self.options.integrator;
 *    var creds = integrator.credentials;
 *  The first assignment creates an "integrator alias", and the second resolves
 *  `integrator.credentials` as a credentials chain root. */
function collectAliases(
  node: TreeSitterNode,
  aliases: Set<string>,
  aliasPatterns: Map<string, string>,
): void {
  // Intermediate aliases for the integrator object (one hop before .credentials)
  // Maps alias name → originating pattern (self vs this)
  const integratorAliases = new Map<string, string>();

  collectAliasesPass(node, aliases, aliasPatterns, integratorAliases);
}

function collectAliasesPass(
  node: TreeSitterNode,
  aliases: Set<string>,
  aliasPatterns: Map<string, string>,
  integratorAliases: Map<string, string>,
): void {
  if (node.type === "variable_declarator") {
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (nameNode && valueNode) {
      const valueText = valueNode.text.trim();
      const normalizedValue = valueText.replace(/\?\./g, '.');

      // Direct credentials alias: var creds = self.options.integrator.credentials
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
      // Integrator alias: var integrator = self.options.integrator
      else if (isIntegratorRoot(valueText)) {
        const alias = nameNode.text.trim();
        if (alias && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(alias)) {
          const pattern = normalizedValue.startsWith("self.")
            ? "self.options.integrator.credentials"
            : "this.options.integrator.credentials";
          integratorAliases.set(alias, pattern);
        }
      }
      // Two-hop resolution: var creds = integrator.credentials (where integrator is an alias)
      else {
        for (const [intAlias, pattern] of integratorAliases) {
          if (
            normalizedValue === `${intAlias}.credentials`
          ) {
            const alias = nameNode.text.trim();
            if (alias && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(alias)) {
              aliases.add(alias);
              aliasPatterns.set(alias, pattern);
            }
            break;
          }
        }
      }
    }
  }

  for (const child of node.children) {
    collectAliasesPass(child, aliases, aliasPatterns, integratorAliases);
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
  const fieldExtractor = (text: string) => extractCredentialField(text, aliases);

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
              const { guards: guardConditions, rawUnmatched } = extractGuardConditionsExt(node, fieldExtractor);
              const line = node.startPosition.row + 1;

              accesses.push({
                field,
                file: filePath,
                line,
                accessKind,
                hasDefault,
                enclosingFunction: findEnclosingFunction(node),
                guardConditions,
                ...(rawUnmatched.length > 0 ? { rawGuardTexts: rawUnmatched } : {}),
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
          let hasDestructuringDefault = false;

          if (prop.type === "shorthand_property_identifier_pattern") {
            fieldName = prop.text;
          } else if (prop.type === "pair_pattern") {
            const keyNode = prop.children[0];
            if (keyNode) {
              fieldName = keyNode.text.replace(/^["']|["']$/g, "");
            }
            // Aliased destructuring with default: `{ foo: bar = 1 } = obj`
            // The pair_pattern contains an assignment_pattern as value child
            if (prop.namedChildren.some((c: TreeSitterNode) => c.type === "assignment_pattern")) {
              hasDestructuringDefault = true;
            }
          } else if (prop.type === "identifier") {
            fieldName = prop.text;
          } else if (prop.type === "object_assignment_pattern") {
            // Destructuring with default: `{ field = defaultValue } = obj`
            const left = prop.children[0];
            if (left) {
              if (
                left.type === "shorthand_property_identifier_pattern" ||
                left.type === "identifier"
              ) {
                fieldName = left.text;
              }
              hasDestructuringDefault = true;
            }
          }

          if (fieldName && fieldName.length > 0) {
            const { guards: guardConditions, rawUnmatched } = extractGuardConditionsExt(node, fieldExtractor);
            const line = node.startPosition.row + 1;
            accesses.push({
              field: fieldName,
              file: filePath,
              line,
              accessKind: hasDestructuringDefault ? "default-fallback" : "read",
              hasDefault: hasDestructuringDefault,
              isDestructured: true,
              enclosingFunction: findEnclosingFunction(node),
              guardConditions,
              ...(rawUnmatched.length > 0 ? { rawGuardTexts: rawUnmatched } : {}),
            });
            byPattern["destructuring"] = (byPattern["destructuring"] ?? 0) + 1;
          }
        }
      }
    }
  }

  // Pattern 1, 2, 6, alias: member_expression
  if (node.type === "member_expression") {
    let nodeText = node.text.trim();
    // If parent is a call_expression, the last segment is a method name, not a field.
    // e.g., credentials.jwtPrivateKey.replace(...) → strip ".replace"
    if (node.parent?.type === "call_expression") {
      const lastDot = nodeText.lastIndexOf('.');
      if (lastDot > 0) {
        nodeText = nodeText.slice(0, lastDot);
      }
    }
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
        const { guards: guardConditions, rawUnmatched } = extractGuardConditionsExt(node, fieldExtractor);
        const resolvedPattern = aliasPatterns.get(nodeText.split(".")[0] ?? "") ?? fieldInfo.pattern;

        accesses.push({
          field: fieldInfo.field,
          file: filePath,
          line,
          accessKind,
          hasDefault,
          enclosingFunction: findEnclosingFunction(node),
          guardConditions,
          ...(rawUnmatched.length > 0 ? { rawGuardTexts: rawUnmatched } : {}),
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

/** Returns a FieldExtractor for the credentials domain (for use in cross-entity detection). */
export function makeCredentialFieldExtractor(): FieldExtractor {
  return (text: string) => extractCredentialField(text, new Set(["credentials"]));
}

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
