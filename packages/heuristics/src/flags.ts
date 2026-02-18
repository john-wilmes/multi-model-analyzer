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
}

const DEFAULT_SDK_IMPORTS = [
  "launchdarkly-node-server-sdk",
  "launchdarkly-js-client-sdk",
  "@launchdarkly/node-server-sdk",
  "@split.io/splitio",
  "flagsmith",
  "unleash-client",
];

const FLAG_ENV_PATTERN = /^(FEATURE_|FF_|FLAG_|ENABLE_|DISABLE_)/;

export function scanForFlags(
  files: ReadonlyMap<string, TreeSitterTree>,
  repo: string,
  options: FlagScannerOptions = {},
): FlagInventory {
  const flagMap = new Map<string, FeatureFlag>();
  const sdkImports = options.sdkImports ?? DEFAULT_SDK_IMPORTS;

  for (const [filePath, tree] of files) {
    // Scan for SDK-based flags
    const imports = findImports(tree.rootNode);
    const usesSDK = imports.some((imp) =>
      sdkImports.some((sdk) => imp.includes(sdk)),
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
