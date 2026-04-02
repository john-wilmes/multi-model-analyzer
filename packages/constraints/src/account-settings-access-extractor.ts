// account-settings-access-extractor.ts — tree-sitter-based account-level settings access extractor
// Tests: account-settings-access-extractor.test.ts
import { initTreeSitter, parseSource } from "@mma/parsing";
import type { TreeSitterNode } from "@mma/parsing";
import type {
  AccessKind,
  CredentialAccess,
  CredentialAccessResult,
} from "./types.js";
import {
  extractGuardConditionsExt,
  hasDefaultFallback,
  isOnAssignmentLeft,
  type FieldExtractor,
} from "./ast-utils.js";

// ─── Account settings chain detection ────────────────────────────────────────

const ACCOUNT_SETTINGS_CHAIN_PREFIXES = [
  "user.settings.",
  "session.user.settings.",
  "req.user.settings.",
  "facility.settings.",
];

/** Returns true if the text is a full account settings chain root (ends at .settings) */
function isAccountSettingsChainRoot(text: string): boolean {
  const normalized = text.replace(/\?\./g, ".");
  return (
    normalized === "user.settings" ||
    normalized === "session.user.settings" ||
    normalized === "req.user.settings" ||
    normalized === "facility.settings"
  );
}

/** Extract the field name from a member expression that accesses an account setting.
 * Returns null if this node doesn't represent an account settings access. */
function extractAccountSettingsField(
  nodeText: string,
  aliases: Set<string>,
): { field: string; pattern: string } | null {
  const normalizedText = nodeText.replace(/\?\./g, ".");

  for (const prefix of ACCOUNT_SETTINGS_CHAIN_PREFIXES) {
    if (normalizedText.startsWith(prefix)) {
      const rest = normalizedText.slice(prefix.length);
      if (rest.length === 0) return null;
      // Skip if rest starts with "integrator." — that's handled by settings-access-extractor
      if (rest.startsWith("integrator.") || rest === "integrator") return null;
      return {
        field: rest,
        pattern: prefix.slice(0, -1), // strip trailing dot
      };
    }
  }

  // Alias pattern: aliasName.fieldName
  for (const alias of aliases) {
    const aliasPrefix = alias + ".";
    if (normalizedText.startsWith(aliasPrefix)) {
      const rest = normalizedText.slice(aliasPrefix.length);
      if (rest.length > 0 && !rest.includes("(")) {
        // Skip integrator sub-accesses
        if (rest.startsWith("integrator.") || rest === "integrator") return null;
        return { field: rest, pattern: "user.settings" };
      }
    }
  }

  return null;
}

// ─── AST walker ──────────────────────────────────────────────────────────────

interface FileAccess {
  accesses: CredentialAccess[];
  byPattern: Record<string, number>;
}

function processFile(filePath: string, root: TreeSitterNode): FileAccess {
  const accesses: CredentialAccess[] = [];
  const byPattern: Record<string, number> = {};

  const aliases = new Set<string>();
  const aliasPatterns = new Map<string, string>();

  collectAliases(root, aliases, aliasPatterns);
  walkNode(root, filePath, aliases, aliasPatterns, accesses, byPattern);

  return { accesses, byPattern };
}

/** Collect account settings aliases from variable declarations */
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
      if (isAccountSettingsChainRoot(valueText)) {
        const alias = nameNode.text.trim();
        if (alias && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(alias)) {
          aliases.add(alias);
          aliasPatterns.set(alias, valueText);
        }
      }
    }
  }

  for (const child of node.children) {
    collectAliases(child, aliases, aliasPatterns);
  }
}

/** Walk AST nodes to find account settings accesses */
function walkNode(
  node: TreeSitterNode,
  filePath: string,
  aliases: Set<string>,
  aliasPatterns: Map<string, string>,
  accesses: CredentialAccess[],
  byPattern: Record<string, number>,
): void {
  const fieldExtractor = (text: string) => extractAccountSettingsField(text, aliases);

  // Lodash get: _.get(user, 'settings.X.Y', default)
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
          const isUserObject =
            firstText === "user" ||
            firstText === "session.user" ||
            firstText === "req.user" ||
            firstText === "facility";

          if (isUserObject) {
            let rawPath: string | null = null;
            if (secondArg.type === "string") {
              rawPath = secondArg.text.slice(1, -1);
            } else if (secondArg.type === "template_string") {
              const inner = secondArg.text.slice(1, -1);
              if (!inner.includes("${")) {
                rawPath = inner;
              }
            }

            if (rawPath !== null) {
              const settingsPrefix = "settings.";
              if (rawPath.startsWith(settingsPrefix)) {
                const field = rawPath.slice(settingsPrefix.length);
                // Skip integrator sub-paths
                if (field.length > 0 && !field.startsWith("integrator.") && field !== "integrator") {
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
    }
  }

  // member_expression: chain prefix patterns and aliases
  if (node.type === "member_expression") {
    let nodeText = node.text.trim();
    // If parent is a call_expression, the last segment is a method name
    if (node.parent?.type === "call_expression") {
      const lastDot = nodeText.lastIndexOf(".");
      if (lastDot > 0) {
        nodeText = nodeText.slice(0, lastDot);
      }
    }
    const fieldInfo = extractAccountSettingsField(nodeText, aliases);

    if (fieldInfo) {
      // Only process the deepest matching expression
      const parentText = node.parent?.text.trim() ?? "";
      const parentMatches =
        node.parent?.type === "member_expression" &&
        extractAccountSettingsField(parentText, aliases) !== null;

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
        const resolvedPattern =
          aliasPatterns.get(nodeText.split(".")[0] ?? "") ?? fieldInfo.pattern;

        accesses.push({
          field: fieldInfo.field,
          file: filePath,
          line,
          accessKind,
          hasDefault,
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

// ─── Public API ──────────────────────────────────────────────────────────────

/** Returns a FieldExtractor for the account-settings domain (for use in cross-entity detection). */
export function makeAccountSettingsFieldExtractor(): FieldExtractor {
  return (text: string) => extractAccountSettingsField(text, new Set());
}

export async function extractAccountSettingsAccesses(
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
