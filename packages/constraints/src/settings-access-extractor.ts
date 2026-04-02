// settings-access-extractor.ts — tree-sitter-based ISC integrator settings access extractor
// Tests: settings-access-extractor.test.ts
import { initTreeSitter, parseSource } from "@mma/parsing";
import type { TreeSitterNode } from "@mma/parsing";
import type {
  AccessKind,
  CredentialAccess,
  CredentialAccessResult,
} from "./types.js";
import {
  extractGuardConditions,
  hasDefaultFallback,
  isOnAssignmentLeft,
} from "./ast-utils.js";

// ─── Settings chain detection ─────────────────────────────────────────────────

const SETTINGS_CHAIN_PREFIXES = [
  "self.options.integrator.settings.integrator.",
  "this.options.integrator.settings.integrator.",
  "integratorObject.settings.integrator.",
];

/** Returns true if the text is a full settings chain root (ends at .settings.integrator) */
function isSettingsChainRoot(text: string): boolean {
  const normalized = text.replace(/\?\./g, ".");
  return (
    normalized === "self.options.integrator.settings.integrator" ||
    normalized === "this.options.integrator.settings.integrator" ||
    normalized === "integratorObject.settings.integrator"
  );
}

/** Extract the field name from a member expression that accesses a settings field.
 * Returns null if this node doesn't represent a settings access. */
function extractSettingsField(
  nodeText: string,
  aliases: Set<string>,
): { field: string; pattern: string } | null {
  // Normalize optional chaining before any prefix matching so that
  // `self.options.integrator.settings?.integrator?.foo` matches the same as
  // `self.options.integrator.settings.integrator.foo`.
  const normalizedText = nodeText.replace(/\?\./g, ".");

  // Pattern 1 & 2: self/this.options.integrator.settings.integrator.fieldName
  // Pattern 3: integratorObject.settings.integrator.fieldName
  for (const prefix of SETTINGS_CHAIN_PREFIXES) {
    if (normalizedText.startsWith(prefix)) {
      const rest = normalizedText.slice(prefix.length);
      // Avoid matching the chain root itself (no field after settings.integrator)
      if (rest.length === 0) return null;
      return {
        field: rest,
        pattern: prefix.startsWith("integratorObject.")
          ? "integratorObject.settings.integrator"
          : prefix.includes("self.")
            ? "self.options.integrator.settings.integrator"
            : "this.options.integrator.settings.integrator",
      };
    }
  }

  // Alias pattern: aliasName.fieldName
  for (const alias of aliases) {
    const aliasPrefix = alias + ".";
    if (normalizedText.startsWith(aliasPrefix)) {
      const rest = normalizedText.slice(aliasPrefix.length);
      // Preserve the full dotted path; skip if it contains a call expression
      if (rest.length > 0 && !rest.includes("(")) {
        return { field: rest, pattern: "self.options.integrator.settings.integrator" };
      }
    }
  }

  return null;
}

// ─── AST walker ───────────────────────────────────────────────────────────────

interface FileAccess {
  accesses: CredentialAccess[];
  byPattern: Record<string, number>;
}

function processFile(filePath: string, root: TreeSitterNode): FileAccess {
  const accesses: CredentialAccess[] = [];
  const byPattern: Record<string, number> = {};

  // Settings aliases found in this file (variable names that hold settings.integrator object)
  const aliases = new Set<string>(["integratorSettings"]);
  const aliasPatterns = new Map<string, string>();

  // First pass: collect variable aliases for settings objects.
  // Known limitation: alias collection is file-scoped (not block-scoped), so a shadowed local
  // variable that reuses a settings alias name will be incorrectly treated as a settings alias.
  // This causes over-reporting (false positives) rather than under-reporting, which is the safe
  // direction for static analysis — we'd rather flag too many fields than miss a required one.
  collectAliases(root, aliases, aliasPatterns);

  // Second pass: walk and extract accesses
  walkNode(root, filePath, aliases, aliasPatterns, accesses, byPattern);

  return { accesses, byPattern };
}

/** Collect settings aliases from variable declarations */
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
      if (isSettingsChainRoot(valueText)) {
        const alias = nameNode.text.trim();
        if (alias && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(alias)) {
          aliases.add(alias);
          const pattern = valueText.startsWith("integratorObject.")
            ? "integratorObject.settings.integrator"
            : valueText.includes("self.")
              ? "self.options.integrator.settings.integrator"
              : "this.options.integrator.settings.integrator";
          aliasPatterns.set(alias, pattern);
        }
      }
    }
  }

  for (const child of node.children) {
    collectAliases(child, aliases, aliasPatterns);
  }
}

/** Walk AST nodes to find settings accesses */
function walkNode(
  node: TreeSitterNode,
  filePath: string,
  aliases: Set<string>,
  aliasPatterns: Map<string, string>,
  accesses: CredentialAccess[],
  byPattern: Record<string, number>,
): void {
  const fieldExtractor = (text: string) => extractSettingsField(text, aliases);

  // Lodash get: _.get(integrator, 'settings.integrator.X', default)
  // The first arg can be `integrator` (bare name), `self.options.integrator`, or any alias
  // that resolves to the integrator object.
  // The second arg string path must start with 'settings.integrator.' — strip that prefix to
  // get the field name.
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
          // Known first-arg identifiers that refer to the integrator object
          const isIntegrator =
            firstText === "integrator" ||
            firstText === "self.options.integrator" ||
            firstText === "this.options.integrator" ||
            aliases.has(firstText);

          if (isIntegrator) {
            let rawPath: string | null = null;
            if (secondArg.type === "string") {
              rawPath = secondArg.text.slice(1, -1);
            } else if (secondArg.type === "template_string") {
              const inner = secondArg.text.slice(1, -1);
              // Skip template strings with interpolations — they produce dynamic keys
              if (!inner.includes("${")) {
                rawPath = inner;
              }
            }

            if (rawPath !== null) {
              const settingsPrefix = "settings.integrator.";
              if (rawPath.startsWith(settingsPrefix)) {
                const field = rawPath.slice(settingsPrefix.length);
                if (field.length > 0) {
                  const hasDefault = thirdArg !== undefined && thirdArg !== null;
                  const accessKind: AccessKind = hasDefault ? "default-fallback" : "read";
                  const guards = extractGuardConditions(node, fieldExtractor);
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
    }
  }

  // member_expression: patterns 1, 2, 3, alias
  if (node.type === "member_expression") {
    let nodeText = node.text.trim();
    // If parent is a call_expression, the last segment is a method name, not a field.
    // e.g., integratorSettings.syncWindow.toString() → strip ".toString"
    if (node.parent?.type === "call_expression") {
      const lastDot = nodeText.lastIndexOf(".");
      if (lastDot > 0) {
        nodeText = nodeText.slice(0, lastDot);
      }
    }
    const fieldInfo = extractSettingsField(nodeText, aliases);

    if (fieldInfo) {
      // Avoid double-counting: only process the "deepest" matching expression
      // i.e., skip if parent is also a member_expression that would also match
      const parentText = node.parent?.text.trim() ?? "";
      const parentMatches =
        node.parent?.type === "member_expression" &&
        extractSettingsField(parentText, aliases) !== null;

      if (!parentMatches) {
        const line = node.startPosition.row + 1;

        let accessKind: AccessKind = "read";
        if (isOnAssignmentLeft(node)) {
          accessKind = "write";
        } else if (hasDefaultFallback(node)) {
          accessKind = "default-fallback";
        }

        const hasDefault = accessKind === "default-fallback";
        const guards = extractGuardConditions(node, fieldExtractor);
        const resolvedPattern =
          aliasPatterns.get(nodeText.split(".")[0] ?? "") ?? fieldInfo.pattern;

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

export async function extractSettingsAccesses(
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
