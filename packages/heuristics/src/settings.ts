/**
 * Configuration settings scanner.
 *
 * Detects configuration parameter access patterns:
 * - Config object property access (config.timeout, settings.maxRetries)
 * - Environment variable access (process.env.DATABASE_URL)
 * - Credential detection (process.env.API_KEY, process.env.DB_PASSWORD)
 * - Default value extraction via ?? or || operators
 * - Zod/Joi/Yup/Ajv validation schema property extraction
 *
 * @see settings.test.ts for unit tests
 */

import type { ConfigParameter, ConfigInventory, ConfigValueType } from "@mma/core";
import type { TreeSitterNode, TreeSitterTree } from "@mma/parsing";

export interface SettingsScannerOptions {
  readonly configObjectNames?: readonly string[];
  readonly envVarPrefixes?: readonly string[];
  readonly credentialPatterns?: readonly string[];
  readonly validatorLibraries?: readonly string[];
  readonly excludePaths?: readonly RegExp[];
  readonly configDefinitionNames?: readonly string[];
}

const DEFAULT_CONFIG_OBJECT_NAMES = ["config", "settings", "options", "opts", "cfg"];

const DEFAULT_ENV_VAR_PREFIXES = [
  "DATABASE_",
  "REDIS_",
  "API_",
  "AWS_",
  "MONGO_",
];

const CREDENTIAL_SUFFIX_PATTERN = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIAL)$/;

const FLAG_ENV_PATTERN = /^(FEATURE_|FF_|FLAG_|ENABLE_|DISABLE_|IS_\w+_ENABLED)/;

const DEFAULT_VALIDATOR_LIBRARIES = ["zod", "joi", "yup", "ajv"];

const DEFAULT_CONFIG_DEFINITION_NAMES = ["configuration"];

const CREDENTIAL_PROP_PATTERN = /password|secret|key|token|credential|apiKey|auth/i;

function constructorToValueType(text: string): ConfigValueType | undefined {
  if (text === "String") return "string";
  if (text === "Number") return "number";
  if (text === "Boolean") return "boolean";
  if (text === "Array") return "unknown";
  if (text === "Object") return "unknown";
  return undefined;
}

/**
 * Path patterns that indicate test/setup files — settings found in these
 * are configuration artifacts, not real application settings.
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

function isTestPath(filePath: string, excludePaths?: readonly RegExp[]): boolean {
  if (TEST_PATH_PATTERNS.some((pattern) => pattern.test(filePath))) return true;
  if (excludePaths?.some((pattern) => pattern.test(filePath))) return true;
  return false;
}

export function scanForSettings(
  files: ReadonlyMap<string, TreeSitterTree>,
  repo: string,
  options: SettingsScannerOptions = {},
): ConfigInventory {
  const paramMap = new Map<string, ConfigParameter>();

  const configObjectNames = options.configObjectNames ?? DEFAULT_CONFIG_OBJECT_NAMES;
  const envVarPrefixes = options.envVarPrefixes ?? DEFAULT_ENV_VAR_PREFIXES;
  const validatorLibraries = options.validatorLibraries ?? DEFAULT_VALIDATOR_LIBRARIES;
  const configDefinitionNames = options.configDefinitionNames ?? DEFAULT_CONFIG_DEFINITION_NAMES;

  for (const [filePath, tree] of files) {
    if (isTestPath(filePath, options.excludePaths)) continue;

    // Scan for config object property accesses
    const configParams = findConfigPropertyAccesses(
      tree.rootNode,
      filePath,
      repo,
      configObjectNames,
    );
    for (const param of configParams) {
      mergeParameter(paramMap, param);
    }

    // Scan for environment variable accesses
    const envParams = findEnvVarAccesses(tree.rootNode, filePath, repo, envVarPrefixes, options.credentialPatterns);
    for (const param of envParams) {
      mergeParameter(paramMap, param);
    }

    // Scan for validation schema definitions
    const importedValidatorNames = getImportedValidatorNames(tree.rootNode, validatorLibraries);

    if (importedValidatorNames.size > 0) {
      const schemaParams = findValidationSchemaParams(tree.rootNode, filePath, repo, importedValidatorNames);
      for (const param of schemaParams) {
        mergeParameter(paramMap, param);
      }
    }

    // Scan for mongoose-style static config definitions
    const mongooseParams = findMongooseStyleDefinitions(
      tree.rootNode,
      filePath,
      repo,
      configDefinitionNames,
    );
    for (const param of mongooseParams) {
      mergeParameter(paramMap, param);
    }
  }

  return { repo, parameters: [...paramMap.values()] };
}

/**
 * Detect config.propName or settings.propName accesses.
 * Also extracts default values from `config.prop ?? defaultValue` and
 * `config.prop || defaultValue` patterns.
 */
function findConfigPropertyAccesses(
  node: TreeSitterNode,
  filePath: string,
  repo: string,
  configObjectNames: readonly string[],
): ConfigParameter[] {
  const params: ConfigParameter[] = [];

  visitAll(node, (n) => {
    if (n.type !== "member_expression") return;

    const obj = n.namedChildren[0];
    const prop = n.namedChildren[n.namedChildren.length - 1];
    if (!obj || !prop) return;

    // Only look for direct identifier access (config.foo), not chained (config.foo.bar)
    if (obj.type !== "identifier") return;
    if (!configObjectNames.includes(obj.text)) return;
    if (prop.type !== "property_identifier") return;

    const settingName = prop.text;

    // Look for default value in parent ?? or || expressions
    let defaultValue: unknown = undefined;
    let valueType: ConfigValueType | undefined = undefined;

    const parent = findParentBinaryExpression(node, n);
    if (parent) {
      const operator = parent.children.find(
        (c) => c.type === "??" || c.type === "||" || c.text === "??" || c.text === "||",
      );
      if (operator) {
        // The right side of the operator should be the default
        const children = parent.namedChildren;
        const rightSide = children[children.length - 1];
        if (rightSide && rightSide !== n) {
          const extracted = extractLiteralValue(rightSide);
          if (extracted !== null) {
            defaultValue = extracted.value;
            valueType = extracted.type;
          }
        }
      }
    }

    params.push({
      name: settingName,
      locations: [{ repo, module: filePath }],
      kind: "setting",
      ...(valueType !== undefined ? { valueType } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    });
  });

  return params;
}

/**
 * Find a binary_expression ancestor of `target` that is an immediate parent.
 * Returns null if the direct parent isn't a binary expression.
 */
function findParentBinaryExpression(
  root: TreeSitterNode,
  target: TreeSitterNode,
): TreeSitterNode | null {
  let result: TreeSitterNode | null = null;

  function search(node: TreeSitterNode): boolean {
    for (const child of node.namedChildren) {
      if (child === target) {
        if (node.type === "binary_expression") {
          result = node;
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
 * Detect process.env.VAR_NAME accesses, classifying as credential or setting.
 * Skips flag-like env vars (handled by the flags scanner).
 */
function findEnvVarAccesses(
  node: TreeSitterNode,
  filePath: string,
  repo: string,
  envVarPrefixes: readonly string[],
  credentialPatterns?: readonly string[],
): ConfigParameter[] {
  const params: ConfigParameter[] = [];

  // Build regex from custom credential patterns (glob-style *_KEY → suffix match)
  const credentialRegexes: RegExp[] = credentialPatterns
    ? credentialPatterns.map((p) => {
        // Convert simple glob patterns like "*_KEY" to a regex
        const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        return new RegExp(`^${escaped}$`);
      })
    : [];

  visitAll(node, (n) => {
    if (n.type !== "member_expression") return;

    // Require the node to be exactly `process.env.VAR_NAME` — two chained member_expressions:
    // outer: process.env  → inner: VAR_NAME
    const obj = n.namedChildren[0];
    const prop = n.namedChildren[n.namedChildren.length - 1];
    if (!obj || !prop) return;

    // obj must be `process.env` (a member_expression itself)
    if (obj.type !== "member_expression") return;
    const processNode = obj.namedChildren[0];
    const envNode = obj.namedChildren[obj.namedChildren.length - 1];
    if (!processNode || !envNode) return;
    if (processNode.text !== "process" || envNode.text !== "env") return;

    // prop must be a direct identifier (not another chain)
    if (prop.type !== "property_identifier" && prop.type !== "identifier") return;

    const envVar = prop.text;

    // Skip flag-like env vars — those are handled by the flags scanner
    if (FLAG_ENV_PATTERN.test(envVar)) return;

    // Determine kind
    let kind: "setting" | "credential";
    const isCredentialBySuffix = CREDENTIAL_SUFFIX_PATTERN.test(envVar);
    const isCredentialByPattern = credentialRegexes.some((re) => re.test(envVar));
    if (isCredentialBySuffix || isCredentialByPattern) {
      kind = "credential";
    } else {
      // Only emit as setting if it matches a known prefix — otherwise skip
      const matchesPrefix = envVarPrefixes.some((prefix) => envVar.startsWith(prefix));
      if (!matchesPrefix) return;
      kind = "setting";
    }

    params.push({
      name: envVar,
      locations: [{ repo, module: filePath }],
      kind,
      source: "process.env",
    });
  });

  return params;
}

/**
 * Walk a member_expression or call_expression chain to find the root identifier.
 * For `z.object`, returns "z". For `Joi.object`, returns "Joi".
 * Returns null when the base is not a simple identifier.
 */
function resolveCalleeBase(node: TreeSitterNode): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "member_expression" || node.type === "call_expression") {
    const first = node.namedChildren[0];
    if (!first) return null;
    return resolveCalleeBase(first);
  }
  return null;
}

/**
 * Detect zod/joi/yup schema object definitions and extract property names.
 * Handles patterns like:
 *   z.object({ timeout: z.number().min(0).max(30000), ... })
 *   Joi.object({ host: Joi.string(), port: Joi.number() })
 *
 * Only treats a `.object({...})` call as a schema root when the callee base
 * resolves to a known imported validator identifier.
 */
function findValidationSchemaParams(
  node: TreeSitterNode,
  filePath: string,
  repo: string,
  importedValidatorNames: Set<string>,
): ConfigParameter[] {
  const params: ConfigParameter[] = [];

  visitAll(node, (n) => {
    if (n.type !== "call_expression") return;

    const callee = n.namedChildren[0];
    if (!callee) return;

    // Match foo.object(...) where foo is a validator identifier
    if (callee.type !== "member_expression") return;
    const methodNode = callee.namedChildren[callee.namedChildren.length - 1];
    if (!methodNode || methodNode.text !== "object") return;

    // Verify the callee base is an imported validator identifier
    const calleeBase = resolveCalleeBase(callee);
    if (!calleeBase || !importedValidatorNames.has(calleeBase)) return;

    const args = n.namedChildren.find((c) => c.type === "arguments");
    if (!args) return;

    // First argument should be an object literal
    const firstArg = args.namedChildren[0];
    if (!firstArg || firstArg.type !== "object") return;

    for (const prop of firstArg.namedChildren) {
      // Handle shorthand_property_identifier and pair nodes
      let propName: string | null = null;
      let valueNode: TreeSitterNode | null = null;

      if (prop.type === "pair") {
        const keyNode = prop.namedChildren[0];
        propName = keyNode?.text?.replace(/['"]/g, "") ?? null;
        valueNode = prop.namedChildren[1] ?? null;
      } else if (
        prop.type === "shorthand_property_identifier" ||
        prop.type === "property_identifier"
      ) {
        propName = prop.text;
      }

      if (!propName) continue;

      // Try to infer value type from chained validator methods
      let valueType: ConfigValueType = "unknown";
      let rangeMin: number | undefined;
      let rangeMax: number | undefined;
      let enumValues: string[] | undefined;

      if (valueNode) {
        const typeInfo = extractValidatorTypeInfo(valueNode);
        valueType = typeInfo.valueType;
        rangeMin = typeInfo.rangeMin;
        rangeMax = typeInfo.rangeMax;
        enumValues = typeInfo.enumValues;
      }

      const param: ConfigParameter = {
        name: propName,
        locations: [{ repo, module: filePath }],
        kind: "setting",
        valueType,
        ...(rangeMin !== undefined ? { rangeMin } : {}),
        ...(rangeMax !== undefined ? { rangeMax } : {}),
        ...(enumValues !== undefined ? { enumValues } : {}),
      };
      params.push(param);
    }
  });

  return params;
}

interface ValidatorTypeInfo {
  valueType: ConfigValueType;
  rangeMin?: number;
  rangeMax?: number;
  enumValues?: string[];
}

/**
 * Walk chained call expressions (e.g. z.number().min(0).max(100)) to
 * extract the base type and any range constraints.
 */
function extractValidatorTypeInfo(node: TreeSitterNode): ValidatorTypeInfo {
  const result: ValidatorTypeInfo = { valueType: "unknown" };
  const methodNames: string[] = [];

  // Collect all chained method names by walking up the call chain
  collectChainedMethodNames(node, methodNames);

  for (const name of methodNames) {
    if (name === "number" || name === "integer") {
      result.valueType = "number";
    } else if (name === "boolean") {
      result.valueType = "boolean";
    } else if (name === "string" || name === "url" || name === "email" || name === "uri") {
      result.valueType = "string";
    } else if (name === "enum") {
      result.valueType = "enum";
    }
  }

  // Extract min/max from call arguments
  collectRangeConstraints(node, result);

  return result;
}

/**
 * Walk a chained call expression to collect method names.
 * For `z.number().min(0).max(100)`, collects ["number", "min", "max"].
 */
function collectChainedMethodNames(node: TreeSitterNode, names: string[]): void {
  if (node.type === "call_expression") {
    const callee = node.namedChildren[0];
    if (callee) {
      collectChainedMethodNames(callee, names);
      // If this call has args, also check for enum values
    }
  } else if (node.type === "member_expression") {
    const obj = node.namedChildren[0];
    const prop = node.namedChildren[node.namedChildren.length - 1];
    if (obj) collectChainedMethodNames(obj, names);
    if (prop?.type === "property_identifier") {
      names.push(prop.text);
    }
  }
}

/**
 * Walk a chained call expression to extract .min() and .max() numeric arguments.
 */
function collectRangeConstraints(node: TreeSitterNode, result: ValidatorTypeInfo): void {
  if (node.type === "call_expression") {
    const callee = node.namedChildren[0];
    const args = node.namedChildren.find((c) => c.type === "arguments");

    if (callee?.type === "member_expression") {
      const prop = callee.namedChildren[callee.namedChildren.length - 1];
      const methodName = prop?.text;

      if (methodName === "min" && args) {
        const firstArg = args.namedChildren[0];
        if (firstArg?.type === "number") {
          result.rangeMin = parseFloat(firstArg.text);
        }
      } else if (methodName === "max" && args) {
        const firstArg = args.namedChildren[0];
        if (firstArg?.type === "number") {
          result.rangeMax = parseFloat(firstArg.text);
        }
      }

      // Recurse into the callee object
      const obj = callee.namedChildren[0];
      if (obj) collectRangeConstraints(obj, result);
    }
  }
}

function mergeParameter(
  map: Map<string, ConfigParameter>,
  param: ConfigParameter,
): void {
  const existing = map.get(param.name);
  if (existing) {
    map.set(param.name, {
      ...existing,
      locations: [...existing.locations, ...param.locations],
      // Keep the more specific kind (credential > setting)
      kind: existing.kind === "credential" || param.kind === "credential"
        ? "credential"
        : existing.kind,
      // Keep the first non-unknown valueType
      valueType: existing.valueType && existing.valueType !== "unknown"
        ? existing.valueType
        : param.valueType,
      // Keep existing values if present; fall back to incoming
      defaultValue: existing.defaultValue !== undefined ? existing.defaultValue : param.defaultValue,
      rangeMin: existing.rangeMin !== undefined ? existing.rangeMin : param.rangeMin,
      rangeMax: existing.rangeMax !== undefined ? existing.rangeMax : param.rangeMax,
      enumValues: existing.enumValues !== undefined ? existing.enumValues : param.enumValues,
      source: existing.source !== undefined ? existing.source : param.source,
      required: existing.required !== undefined ? existing.required : param.required,
      description: existing.description !== undefined ? existing.description : param.description,
    });
  } else {
    map.set(param.name, param);
  }
}

/**
 * Detect mongoose-style static configuration object definitions.
 * Handles two patterns:
 *
 * Assignment: `Foo.configuration = { username: String, ... }`
 * Variable:   `export const configuration = { ... } satisfies IntegrationConfig<...>`
 *
 * Each property in the object is extracted as a ConfigParameter.
 * Properties with bare constructor values (String, Boolean, Number) get their type inferred.
 * Properties with nested objects ({ type: Boolean, default: false, ... }) get full metadata.
 */
function findMongooseStyleDefinitions(
  node: TreeSitterNode,
  filePath: string,
  repo: string,
  configDefinitionNames: readonly string[],
): ConfigParameter[] {
  const params: ConfigParameter[] = [];

  visitAll(node, (n) => {
    let objectNode: TreeSitterNode | null = null;

    // Shape A: assignment_expression — Foo.configuration = { ... }
    if (n.type === "assignment_expression") {
      const left = n.namedChildren[0];
      const right = n.namedChildren[1];
      if (!left || !right) return;
      if (left.type !== "member_expression") return;
      const prop = left.namedChildren[left.namedChildren.length - 1];
      if (!prop || !configDefinitionNames.includes(prop.text)) return;
      objectNode = right.type === "object" ? right : null;
    }

    // Shape B: variable_declarator — const configuration = { ... } [satisfies ...]
    if (n.type === "variable_declarator") {
      const nameNode = n.namedChildren[0];
      if (!nameNode || !configDefinitionNames.includes(nameNode.text)) return;
      const valueNode = n.namedChildren[n.namedChildren.length - 1];
      if (!valueNode || valueNode === nameNode) return;
      // Handle satisfies_expression (TS 4.9+) — descend into first child
      if (valueNode.type === "satisfies_expression") {
        const inner = valueNode.namedChildren[0];
        objectNode = inner?.type === "object" ? inner : null;
      } else if (valueNode.type === "object") {
        objectNode = valueNode;
      }
    }

    if (!objectNode) return;

    for (const prop of objectNode.namedChildren) {
      if (prop.type !== "pair") continue;
      const keyNode = prop.namedChildren[0];
      const valueNode = prop.namedChildren[1];
      if (!keyNode || !valueNode) continue;

      const propName = keyNode.text.replace(/['"]/g, "");

      let valueType: ConfigValueType = "unknown";
      let defaultValue: unknown = undefined;
      let description: string | undefined = undefined;
      let required: boolean | undefined = undefined;

      if (valueNode.type === "identifier") {
        // Bare constructor: `username: String`
        valueType = constructorToValueType(valueNode.text) ?? "unknown";
      } else if (valueNode.type === "object") {
        // Nested object: `{ type: Boolean, default: false, description: '...' }`
        for (const inner of valueNode.namedChildren) {
          if (inner.type !== "pair") continue;
          const innerKey = inner.namedChildren[0];
          const innerVal = inner.namedChildren[1];
          if (!innerKey || !innerVal) continue;
          const k = innerKey.text.replace(/['"]/g, "");

          if (k === "type" && innerVal.type === "identifier") {
            valueType = constructorToValueType(innerVal.text) ?? "unknown";
          } else if (k === "default") {
            const extracted = extractLiteralValue(innerVal);
            if (extracted !== null) {
              defaultValue = extracted.value;
              if (valueType === "unknown") valueType = extracted.type;
            }
          } else if (k === "description") {
            const extracted = extractLiteralValue(innerVal);
            if (extracted !== null && typeof extracted.value === "string") {
              description = extracted.value;
            }
          } else if (k === "required") {
            required = innerVal.text === "true";
          }
        }
      }

      // Determine kind — credential if property name matches credential pattern
      const kind: "setting" | "credential" = CREDENTIAL_PROP_PATTERN.test(propName)
        ? "credential"
        : "setting";

      params.push({
        name: propName,
        locations: [{ repo, module: filePath }],
        kind,
        valueType,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(required !== undefined ? { required } : {}),
      });
    }
  });

  return params;
}

interface LiteralExtraction {
  value: unknown;
  type: ConfigValueType;
}

function extractLiteralValue(node: TreeSitterNode): LiteralExtraction | null {
  if (node.type === "number") {
    return { value: parseFloat(node.text), type: "number" };
  }
  if (node.type === "true" || node.text === "true") {
    return { value: true, type: "boolean" };
  }
  if (node.type === "false" || node.text === "false") {
    return { value: false, type: "boolean" };
  }
  if (node.type === "string") {
    const val = node.text.replace(/['"]/g, "");
    return { value: val, type: "string" };
  }
  return null;
}

/**
 * Collect the local identifiers that are imported from any of the configured
 * validator libraries. Returns a Set of local names so callee-checking is O(1).
 *
 * Example:
 *   import { z } from "zod"                 → adds "z"
 *   import Joi from "joi"                    → adds "Joi"
 *   import * as yup from "yup"              → adds "yup"
 *   import { object } from "yup"            → adds "object" (namespace import)
 */
function getImportedValidatorNames(
  node: TreeSitterNode,
  validatorLibraries: readonly string[],
): Set<string> {
  const names = new Set<string>();

  for (const child of node.namedChildren) {
    if (child.type !== "import_statement") continue;

    // Check whether this import is from a validator library
    const source = extractStringLiteral(child);
    if (!source) continue;
    const isValidatorLib = validatorLibraries.some(
      (lib) => source === lib || source.startsWith(lib + "/"),
    );
    if (!isValidatorLib) continue;

    // Collect local binding names from the import statement
    for (const clause of child.namedChildren) {
      if (clause.type === "import_clause") {
        for (const binding of clause.namedChildren) {
          // Default import: `import Joi from "joi"` → identifier node
          if (binding.type === "identifier") {
            names.add(binding.text);
          }
          // Namespace import: `import * as yup from "yup"` → namespace_import
          if (binding.type === "namespace_import") {
            const id = binding.namedChildren.find((c) => c.type === "identifier");
            if (id) names.add(id.text);
          }
          // Named imports: `import { z } from "zod"` → named_imports
          if (binding.type === "named_imports") {
            for (const spec of binding.namedChildren) {
              // import_specifier has the local alias as the last identifier
              const localId = spec.namedChildren[spec.namedChildren.length - 1];
              if (localId?.type === "identifier") names.add(localId.text);
            }
          }
        }
      }
    }
  }

  return names;
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
