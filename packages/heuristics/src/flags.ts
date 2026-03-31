/**
 * Feature flag inventory scanner.
 *
 * Detects feature flag evaluation patterns:
 * - if/switch on config keys
 * - LaunchDarkly SDK calls (variation, useFlags)
 * - Split.io SDK calls (getTreatment)
 * - Environment variable checks (process.env.FEATURE_*)
 * - Custom flag evaluation patterns
 */

import type { FeatureFlag, FlagInventory } from "@mma/core";
import type { TreeSitterNode, TreeSitterTree } from "@mma/parsing";

export interface FlagScannerOptions {
  readonly customPatterns?: readonly RegExp[];
  readonly sdkImports?: readonly string[];
  readonly registryFlags?: readonly FeatureFlag[];
  readonly rolloutCallMethods?: readonly string[];
  readonly flagPropertyName?: string;
  readonly registryEnumName?: string;
}

const DEFAULT_SDK_IMPORTS = [
  "launchdarkly-node-server-sdk",
  "launchdarkly-js-client-sdk",
  "@launchdarkly/node-server-sdk",
  "@split.io/splitio",
  "flagsmith",
  "unleash-client",
];

const FLAG_ENV_PATTERN = /^(FEATURE_|FF_|FLAG_|ENABLE_|DISABLE_|IS_\w+_ENABLED)/;

/**
 * Path patterns that indicate test/setup files — flags found in these
 * are configuration artifacts, not real feature flags.
 */
const TEST_PATH_PATTERNS = [
  /\.test\./,
  /\.spec\./,
  /(^|\/)__tests__\//,
  /(^|\/)test\//,
  /(^|\/)jest\.config\./,
  /(^|\/)vitest\.config\./,
  /\.setup\./,
  /(^|\/)(?:test|tests|__tests__)\/(?:.*\/)?fixtures?\//,
  /(^|\/)(?:test|tests|__tests__)\/(?:.*\/)?helpers?\//,
  /(^|\/)__mocks__\//,
];

function isTestPath(filePath: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function scanForFlags(
  files: ReadonlyMap<string, TreeSitterTree>,
  repo: string,
  options: FlagScannerOptions = {},
): FlagInventory {
  const flagMap = new Map<string, FeatureFlag>();
  const sdkImports = options.sdkImports ?? DEFAULT_SDK_IMPORTS;

  for (const [filePath, tree] of files) {
    // Skip test/setup/fixture files — flags there are config artifacts
    if (isTestPath(filePath)) continue;

    // Scan for SDK-based flags
    const imports = findImports(tree.rootNode);
    const usesSDK = imports.some((imp) =>
      sdkImports.some((sdk) => imp === sdk || imp.startsWith(sdk + "/")),
    );

    if (usesSDK) {
      const sdkFlags = findSdkFlagCalls(tree.rootNode, filePath, repo);
      for (const flag of sdkFlags) {
        mergeFlag(flagMap, flag);
      }
    }

    // Scan for env-based flags
    const envFlags = findEnvFlags(tree.rootNode, filePath, repo);
    for (const flag of envFlags) {
      mergeFlag(flagMap, flag);
    }

    // Scan for hook-based flags (React)
    const hookFlags = findHookFlags(tree.rootNode, filePath, repo);
    for (const flag of hookFlags) {
      mergeFlag(flagMap, flag);
    }

    // Scan for enum-based feature flags (e.g., FeatureFlagKey.IS_AI_ENABLED)
    const enumFlags = findEnumFlags(tree.rootNode, filePath, repo);
    for (const flag of enumFlags) {
      mergeFlag(flagMap, flag);
    }

    // Scan for rollout/featureFlags patterns (flags stored in Redis or user.featureFlags)
    const rolloutFlags = findRolloutFlags(tree.rootNode, filePath, repo, options.rolloutCallMethods, options.flagPropertyName);
    for (const flag of rolloutFlags) {
      mergeFlag(flagMap, flag);
    }

    // Scan custom patterns
    if (options.customPatterns) {
      const customFlags = findCustomPatternFlags(
        tree.rootNode,
        filePath,
        repo,
        options.customPatterns,
      );
      for (const flag of customFlags) {
        mergeFlag(flagMap, flag);
      }
    }
  }

  // Merge registry flags: annotate detected flags and add undetected ones
  if (options.registryFlags) {
    for (const regFlag of options.registryFlags) {
      const existing = flagMap.get(regFlag.name);
      if (existing) {
        flagMap.set(regFlag.name, {
          ...existing,
          isRegistry: true,
          description: regFlag.description ?? existing.description,
          namespaces: regFlag.namespaces ?? existing.namespaces,
        });
      } else {
        flagMap.set(regFlag.name, regFlag);
      }
    }
  }

  return { repo, flags: [...flagMap.values()] };
}

function findImports(node: TreeSitterNode): string[] {
  const imports: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "import_statement") {
      const source = extractStringLiteral(child);
      if (source) imports.push(source);
    }
  }
  return imports;
}

function findSdkFlagCalls(
  node: TreeSitterNode,
  filePath: string,
  repo: string,
): FeatureFlag[] {
  const flags: FeatureFlag[] = [];
  const sdkMethods = ["variation", "useFlags", "getTreatment", "isEnabled", "getValue"];

  visitAll(node, (n) => {
    if (n.type === "call_expression") {
      const callee = n.namedChildren[0];
      if (!callee) return;

      const methodName = extractMethodName(callee);
      if (methodName && sdkMethods.includes(methodName)) {
        const args = n.namedChildren.find((c) => c.type === "arguments");
        if (args) {
          const firstArg = args.namedChildren[0];
          if (firstArg && (firstArg.type === "string" || firstArg.type === "template_string")) {
            const flagName = extractStringLiteral(firstArg) ?? firstArg.text;
            flags.push({
              name: flagName.replace(/['"]/g, ""),
              locations: [{ repo, module: filePath }],
              sdk: methodName,
            });
          }
        }
      }
    }
  });

  return flags;
}

function findEnvFlags(
  node: TreeSitterNode,
  filePath: string,
  repo: string,
): FeatureFlag[] {
  const flags: FeatureFlag[] = [];

  visitAll(node, (n) => {
    if (n.type === "member_expression" && n.text.startsWith("process.env.")) {
      const envVar = n.text.replace("process.env.", "");
      if (FLAG_ENV_PATTERN.test(envVar)) {
        flags.push({
          name: envVar,
          locations: [{ repo, module: filePath }],
        });
      }
    }
  });

  return flags;
}

/** Detect feature flag access via React hooks and config objects. */
function findHookFlags(
  node: TreeSitterNode,
  filePath: string,
  repo: string,
): FeatureFlag[] {
  const flags: FeatureFlag[] = [];
  const hookPatterns = ["useFeatureFlag", "useFeatureFlags", "useFlag", "useFlags", "useFeatureGate"];

  visitAll(node, (n) => {
    if (n.type === "call_expression") {
      const callee = n.namedChildren[0];
      if (!callee) return;

      const name = callee.type === "identifier" ? callee.text : extractMethodName(callee);
      if (name && hookPatterns.includes(name)) {
        // Try to extract the flag name from the first argument
        const args = n.namedChildren.find((c) => c.type === "arguments");
        if (args) {
          const firstArg = args.namedChildren[0];
          if (firstArg && (firstArg.type === "string" || firstArg.type === "template_string")) {
            const flagName = extractStringLiteral(firstArg) ?? firstArg.text;
            flags.push({
              name: flagName.replace(/['"]/g, ""),
              locations: [{ repo, module: filePath }],
              sdk: name,
            });
          }
        }
      }
    }
  });

  return flags;
}

function findCustomPatternFlags(
  node: TreeSitterNode,
  filePath: string,
  repo: string,
  patterns: readonly RegExp[],
): FeatureFlag[] {
  const flags: FeatureFlag[] = [];

  visitAll(node, (n) => {
    if (n.type === "string" || n.type === "template_string") {
      const text = n.text.replace(/['"`]/g, "");
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          flags.push({
            name: text,
            locations: [{ repo, module: filePath }],
          });
          break;
        }
      }
    }
  });

  return flags;
}

/**
 * Detect rollout/featureFlags patterns:
 * - isRolledOut(id, 'flag-name') / isUserRolledOut(id, id, 'flag-name')
 * - addRollout(id, 'flag-name') / removeRollout(id, 'flag-name')
 * - featureFlags.includes('flag-name')
 * - getAllRollouts(id) — marks file as rollout-aware but no specific flag name
 */
const ROLLOUT_CALL_METHODS = [
  "isRolledOut",
  "isUserRolledOut",
  "addRollout",
  "removeRollout",
];

/**
 * Given a variable name, search the AST for a const/let/var declaration whose
 * initializer is a string literal and return that literal value.
 */
function resolveIdentifierValue(
  rootNode: TreeSitterNode,
  name: string,
): string | null {
  let result: string | null = null;
  visitAll(rootNode, (n) => {
    if (result) return;
    // variable_declaration or lexical_declaration: const/let/var x = '...'
    if (
      n.type === "variable_declaration" ||
      n.type === "lexical_declaration"
    ) {
      for (const declarator of n.namedChildren) {
        if (declarator.type !== "variable_declarator") continue;
        const nameNode = declarator.namedChildren[0];
        if (!nameNode || nameNode.text !== name) continue;
        const initNode = declarator.namedChildren[1];
        if (!initNode) continue;
        if (initNode.type === "string" || initNode.type === "template_string") {
          result = (extractStringLiteral(initNode) ?? initNode.text).replace(/['"]/g, "");
        }
      }
    }
  });
  return result;
}

/**
 * Given a property name from `this.PROP_NAME`, search the AST for a class
 * property declaration whose initializer is a string literal and return it.
 */
function resolveMemberExpressionValue(
  rootNode: TreeSitterNode,
  propName: string,
): string | null {
  let result: string | null = null;
  visitAll(rootNode, (n) => {
    if (result) return;
    // public_field_definition: PROP_NAME = '...'
    // property_declaration (TypeScript): readonly PROP_NAME = '...'
    if (
      n.type === "public_field_definition" ||
      n.type === "property_declaration"
    ) {
      const nameNode = n.namedChildren.find(
        (c) =>
          c.type === "property_identifier" ||
          c.type === "identifier" ||
          c.type === "private_property_identifier",
      );
      if (!nameNode || nameNode.text !== propName) return;
      const valueNode = n.namedChildren[n.namedChildren.length - 1];
      if (!valueNode) return;
      if (valueNode.type === "string" || valueNode.type === "template_string") {
        result = (extractStringLiteral(valueNode) ?? valueNode.text).replace(/['"]/g, "");
      }
    }
  });
  return result;
}

/**
 * Try to resolve a flag name from an AST argument node. Returns the string
 * value if the node is a string literal, or if it is an identifier / member
 * expression that resolves to a string literal declaration in `rootNode`.
 */
function resolveArgToFlagName(
  argNode: TreeSitterNode,
  rootNode: TreeSitterNode,
): string | null {
  if (argNode.type === "string" || argNode.type === "template_string") {
    return (extractStringLiteral(argNode) ?? argNode.text).replace(/['"]/g, "");
  }
  if (argNode.type === "identifier") {
    return resolveIdentifierValue(rootNode, argNode.text);
  }
  // this.SOME_CONSTANT
  if (argNode.type === "member_expression") {
    const obj = argNode.namedChildren[0];
    const prop = argNode.namedChildren[argNode.namedChildren.length - 1];
    if (obj?.text === "this" && prop?.type === "property_identifier") {
      return resolveMemberExpressionValue(rootNode, prop.text);
    }
  }
  return null;
}

function findRolloutFlags(
  node: TreeSitterNode,
  filePath: string,
  repo: string,
  rolloutMethods?: readonly string[],
  flagPropName?: string,
): FeatureFlag[] {
  const flags: FeatureFlag[] = [];

  visitAll(node, (n) => {
    if (n.type !== "call_expression") return;
    const callee = n.namedChildren[0];
    if (!callee) return;

    const methodName =
      callee.type === "identifier" ? callee.text : extractMethodName(callee);
    if (!methodName) return;

    // Pattern 1: isRolledOut(id, 'flag'), addRollout(id, 'flag'), etc.
    // Flag name may be a string literal, variable, or this.CONSTANT.
    // Collect all string args (direct or resolved), then use the last one found.
    if ((rolloutMethods ?? ROLLOUT_CALL_METHODS).includes(methodName)) {
      const args = n.namedChildren.find((c) => c.type === "arguments");
      if (!args) return;

      const resolvedNames: string[] = [];
      for (const arg of args.namedChildren) {
        const resolved = resolveArgToFlagName(arg, node);
        if (resolved) resolvedNames.push(resolved);
      }
      const flagName = resolvedNames[resolvedNames.length - 1];
      if (flagName) {
        flags.push({
          name: flagName,
          locations: [{ repo, module: filePath }],
          sdk: methodName,
        });
      }
    }

    // Pattern 2: featureFlags.includes('flag') or .featureFlags?.includes('flag')
    if (methodName === "includes" && callee.type === "member_expression") {
      const obj = callee.namedChildren[0];
      if (!obj) return;
      const objText = obj.type === "member_expression"
        ? (obj.namedChildren[obj.namedChildren.length - 1]?.text ?? "")
        : obj.text;
      if (objText === (flagPropName ?? "featureFlags")) {
        const args = n.namedChildren.find((c) => c.type === "arguments");
        const firstArg = args?.namedChildren[0];
        if (firstArg && (firstArg.type === "string" || firstArg.type === "template_string")) {
          const flagName = (extractStringLiteral(firstArg) ?? firstArg.text).replace(/['"]/g, "");
          flags.push({
            name: flagName,
            locations: [{ repo, module: filePath }],
            sdk: "featureFlags.includes",
          });
        }
      }
    }
  });

  return flags;
}

/**
 * Extract a canonical FeatureFlags enum registry from the provided files.
 *
 * Looks for an `enum_declaration` named exactly `FeatureFlags` and extracts
 * each member's string value (right-hand side of `=`). Also attempts to
 * extract `description` and `namespaces` from a companion `FeatureFlagsMetadata`
 * const using regex over the raw file text.
 *
 * Returns one FeatureFlag per enum member, each tagged with `isRegistry: true`
 * and `sdk: "FeatureFlags"`.
 *
 * @param files     Map of filePath -> TreeSitterTree (same format as scanForFlags)
 * @param repo      Repository name/identifier
 * @param fileTexts Optional map of filePath -> raw file text, used for metadata extraction
 */
export function extractFlagRegistry(
  files: ReadonlyMap<string, TreeSitterTree>,
  repo: string,
  fileTexts?: ReadonlyMap<string, string>,
  enumName?: string,
): FeatureFlag[] {
  for (const [filePath, tree] of files) {
    const text = fileTexts?.get(filePath);
    const result = extractFlagRegistryFromNode(tree.rootNode, filePath, repo, text, enumName);
    if (result.length > 0) return result;
  }
  return [];
}

/**
 * Text-only fallback for extracting the flag registry when tree-sitter trees
 * are unavailable (e.g., incremental mode with no file changes).
 * Uses regex to parse the FeatureFlags enum and its metadata.
 */
export function extractFlagRegistryFromText(
  text: string,
  filePath: string,
  repo: string,
  enumName?: string,
): FeatureFlag[] {
  const resolvedEnum = enumName ?? "FeatureFlags";
  const escaped = resolvedEnum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Extract enum members: KeyName = 'string-value'
  const enumMatch = text.match(new RegExp("enum\\s+" + escaped + "\\s*\\{([^}]+)\\}", "s"));
  if (!enumMatch) return [];

  const enumBody = enumMatch[1]!;
  const memberPattern = /(\w+)\s*=\s*['"]([^'"]+)['"]/g;
  const enumValues = new Map<string, string>();
  for (const m of enumBody.matchAll(memberPattern)) {
    enumValues.set(m[1]!, m[2]!);
  }
  if (enumValues.size === 0) return [];

  // Extract metadata (same regex as tree-sitter path)
  const metadataMap = new Map<string, { description?: string; namespaces?: string[] }>();
  const descPattern = new RegExp("\\[" + escaped + "\\.(\\w+)\\][^}]*?description:\\s*['\"]([^'\"]+)['\"]", "gs");
  for (const match of text.matchAll(descPattern)) {
    const keyName = match[1];
    const description = match[2];
    if (!keyName || !description) continue;
    const entry = metadataMap.get(keyName) ?? {};
    entry.description = description;
    metadataMap.set(keyName, entry);
  }
  const nsPattern = new RegExp("\\[" + escaped + "\\.(\\w+)\\][^}]*?namespaces:\\s*\\[([^\\]]*)\\]", "gs");
  for (const match of text.matchAll(nsPattern)) {
    const keyName = match[1];
    const nsContent = match[2];
    if (!keyName || nsContent === undefined) continue;
    const namespaces = [...nsContent.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] ?? "").filter(Boolean);
    if (namespaces.length > 0) {
      const entry = metadataMap.get(keyName) ?? {};
      entry.namespaces = namespaces;
      metadataMap.set(keyName, entry);
    }
  }

  const flags: FeatureFlag[] = [];
  for (const [keyName, stringValue] of enumValues) {
    const meta = metadataMap.get(keyName);
    flags.push({
      name: stringValue,
      isRegistry: true,
      locations: [{ repo, module: filePath }],
      sdk: resolvedEnum,
      ...(meta?.description !== undefined ? { description: meta.description } : {}),
      ...(meta?.namespaces !== undefined ? { namespaces: meta.namespaces } : {}),
    });
  }
  return flags;
}

function extractFlagRegistryFromNode(
  root: TreeSitterNode,
  filePath: string,
  repo: string,
  fileText: string | undefined,
  enumName?: string,
): FeatureFlag[] {
  const resolvedEnum = enumName ?? "FeatureFlags";
  const escaped = resolvedEnum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Step 1: Find the enum and build keyName -> stringValue map
  const enumValues = new Map<string, string>(); // keyName -> string value

  visitAll(root, (n) => {
    if (n.type !== "enum_declaration") return;
    const nameNode = n.namedChildren.find(
      (c) => c.type === "identifier" || c.type === "type_identifier",
    );
    if (!nameNode || nameNode.text !== resolvedEnum) return;

    const body = n.namedChildren.find((c) => c.type === "enum_body");
    if (!body) return;

    for (const member of body.namedChildren) {
      if (member.type === "enum_assignment") {
        const keyNode = member.namedChildren.find(
          (c) => c.type === "property_identifier" || c.type === "identifier",
        );
        const valueNode = member.namedChildren.find(
          (c) => c.type === "string" || c.type === "template_string",
        );
        if (keyNode && valueNode) {
          const stringValue = (extractStringLiteral(valueNode) ?? valueNode.text).replace(/['"]/g, "");
          enumValues.set(keyNode.text, stringValue);
        }
      } else if (member.type === "property_identifier" || member.type === "identifier") {
        // Enum member without explicit value — use the key name as value
        enumValues.set(member.text, member.text);
      }
    }
  });

  if (enumValues.size === 0) return [];

  // Step 2: Extract metadata via regex if file text is available
  // FeatureFlagsMetadata entries look like:
  //   [FeatureFlags.KeyName]: { description: 'some desc', namespaces: ['ns1', 'ns2'] }
  const metadataMap = new Map<string, { description?: string; namespaces?: string[] }>();

  if (fileText) {
    // Extract description per key
    const descPattern = new RegExp("\\[" + escaped + "\\.(\\w+)\\][^}]*?description:\\s*['\"]([^'\"]+)['\"]", "gs");
    for (const match of fileText.matchAll(descPattern)) {
      const keyName = match[1];
      const description = match[2];
      if (!keyName || !description) continue;
      const entry = metadataMap.get(keyName) ?? {};
      entry.description = description;
      metadataMap.set(keyName, entry);
    }

    // Extract namespaces per key (array of strings)
    const nsPattern = new RegExp("\\[" + escaped + "\\.(\\w+)\\][^}]*?namespaces:\\s*\\[([^\\]]*)\\]", "gs");
    for (const match of fileText.matchAll(nsPattern)) {
      const keyName = match[1];
      const nsContent = match[2];
      if (!keyName || nsContent === undefined) continue;
      const namespaces = [...nsContent.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] ?? "").filter(Boolean);
      if (namespaces.length > 0) {
        const entry = metadataMap.get(keyName) ?? {};
        entry.namespaces = namespaces;
        metadataMap.set(keyName, entry);
      }
    }
  }

  // Step 3: Build FeatureFlag entries
  const flags: FeatureFlag[] = [];
  for (const [keyName, stringValue] of enumValues) {
    const meta = metadataMap.get(keyName);
    const flag: FeatureFlag = {
      name: stringValue,
      isRegistry: true,
      locations: [{ repo, module: filePath }],
      sdk: resolvedEnum,
      ...(meta?.description !== undefined ? { description: meta.description } : {}),
      ...(meta?.namespaces !== undefined ? { namespaces: meta.namespaces } : {}),
    };
    flags.push(flag);
  }

  return flags;
}

function mergeFlag(
  map: Map<string, FeatureFlag>,
  flag: FeatureFlag,
): void {
  const existing = map.get(flag.name);
  if (existing) {
    map.set(flag.name, {
      ...existing,
      locations: [...existing.locations, ...flag.locations],
      sdk: existing.sdk ?? flag.sdk,
    });
  } else {
    map.set(flag.name, flag);
  }
}

const ENUM_FLAG_PATTERN = /^(IS_\w+_ENABLED|FEATURE_\w+|FF_\w+|FLAG_\w+|ENABLE_\w+|DISABLE_\w+)$/;

function findEnumFlags(
  node: TreeSitterNode,
  filePath: string,
  repo: string,
): FeatureFlag[] {
  const flags: FeatureFlag[] = [];

  visitAll(node, (n) => {
    // Match enum declarations with flag-like members
    if (n.type === "enum_declaration") {
      const body = n.namedChildren.find((c) => c.type === "enum_body");
      if (!body) return;

      for (const member of body.namedChildren) {
        if (member.type !== "enum_assignment" && member.type !== "property_identifier") continue;
        const nameNode = member.type === "enum_assignment"
          ? member.namedChildren.find((c) => c.type === "property_identifier")
          : member;
        const memberName = nameNode?.text ?? member.text;
        if (ENUM_FLAG_PATTERN.test(memberName)) {
          flags.push({
            name: memberName,
            locations: [{ repo, module: filePath }],
          });
        }
      }
    }
  });

  return flags;
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

function extractMethodName(node: TreeSitterNode): string | null {
  if (node.type === "member_expression") {
    const prop = node.namedChildren[node.namedChildren.length - 1];
    return prop?.type === "property_identifier" ? prop.text : null;
  }
  if (node.type === "identifier") return node.text;
  return null;
}

function extractStringLiteral(node: TreeSitterNode): string | null {
  for (const child of node.namedChildren) {
    if (child.type === "string" || child.type === "string_fragment") {
      return child.text.replace(/['"]/g, "");
    }
    const found = extractStringLiteral(child);
    if (found) return found;
  }
  return null;
}
