import { initTreeSitter, parseSource } from "@mma/parsing";
import type { TreeSitterNode } from "@mma/parsing";
import type { ConfigField, ConfigSchema, ConfigSchemaExtractionResult } from "./types.js";
import {
  inferTypeFromConstructor,
  extractDefaultValue,
  extractDescriptor,
  looksLikeDescriptor,
  TYPE_CONSTRUCTOR_MAP,
} from "./config-schema-extractor.js";

// Tests: mongoose-schema-extractor.test.ts

// ─── Const resolver ───────────────────────────────────────────────────────────

/**
 * Walk top-level statements and collect `const NAME = { ... }` definitions
 * (object literals only) into a map from name → object node.
 */
function buildConstMap(root: TreeSitterNode): Map<string, TreeSitterNode> {
  const map = new Map<string, TreeSitterNode>();

  for (const stmt of root.namedChildren) {
    // const declarations appear as lexical_declaration at the top level
    if (stmt.type !== "lexical_declaration") continue;

    for (const declarator of stmt.namedChildren) {
      if (declarator.type !== "variable_declarator") continue;

      const nameNode = declarator.childForFieldName("name");
      const valueNode = declarator.childForFieldName("value");
      if (!nameNode || !valueNode) continue;

      if (valueNode.type === "object") {
        map.set(nameNode.text, valueNode);
      }
    }
  }

  return map;
}

// ─── Find the integrator block inside `const settings = { ... }` ─────────────

function findIntegratorBlock(root: TreeSitterNode): TreeSitterNode | null {
  for (const stmt of root.namedChildren) {
    if (stmt.type !== "lexical_declaration") continue;

    for (const declarator of stmt.namedChildren) {
      if (declarator.type !== "variable_declarator") continue;

      const nameNode = declarator.childForFieldName("name");
      const valueNode = declarator.childForFieldName("value");
      if (!nameNode || !valueNode) continue;
      if (nameNode.text !== "settings") continue;
      if (valueNode.type !== "object") continue;

      // Found `const settings = { ... }` — look for the `integrator:` pair
      for (const child of valueNode.namedChildren) {
        if (child.type !== "pair") continue;

        const keyNode = child.children[0];
        const pairValue = child.children[2];
        if (!keyNode || !pairValue) continue;

        const key = keyNode.text.replace(/^["']|["']$/g, "");
        if (key === "integrator" && pairValue.type === "object") {
          return pairValue;
        }
      }
    }
  }

  return null;
}

// ─── Recursive field extraction ───────────────────────────────────────────────

function extractFieldsFromMongooseObject(
  objectNode: TreeSitterNode,
  filePath: string,
  prefix: string,
  constMap: Map<string, TreeSitterNode>,
): ConfigField[] {
  const fields: ConfigField[] = [];

  for (const child of objectNode.namedChildren) {
    // Shorthand property: `{ freshnessMapExpiration, parallelSyncs }`
    if (child.type === "shorthand_property_identifier") {
      const name = child.text;
      const resolved = constMap.get(name);
      if (resolved) {
        const nestedPrefix = prefix ? `${prefix}.${name}` : name;
        const nested = extractFieldsFromMongooseObject(resolved, filePath, nestedPrefix, constMap);
        fields.push(...nested);
      }
      // If not in const map, skip silently
      continue;
    }

    if (child.type !== "pair") continue;

    const keyNode = child.children[0];
    const valueNode = child.children[2];
    if (!keyNode || !valueNode) continue;

    const rawKey = keyNode.text.replace(/^["']|["']$/g, "");
    const fieldName = prefix ? `${prefix}.${rawKey}` : rawKey;
    const line = keyNode.startPosition.row + 1;

    if (valueNode.type === "identifier") {
      const identName = valueNode.text;

      if (identName in TYPE_CONSTRUCTOR_MAP) {
        // Bare type constructor: `username: String`
        fields.push({
          name: fieldName,
          inferredType: inferTypeFromConstructor(identName),
          hasDefault: false,
          required: undefined,
          source: { file: filePath, line },
        });
      } else {
        // Identifier referencing a top-level const
        const resolved = constMap.get(identName);
        if (resolved) {
          const nested = extractFieldsFromMongooseObject(resolved, filePath, fieldName, constMap);
          fields.push(...nested);
        } else {
          // Unknown identifier — record as unknown
          fields.push({
            name: fieldName,
            inferredType: "unknown",
            hasDefault: false,
            required: undefined,
            source: { file: filePath, line },
          });
        }
      }
    } else if (valueNode.type === "object") {
      if (looksLikeDescriptor(valueNode)) {
        // Descriptor object: `{ type: Boolean, required: false, default: true }`
        const desc = extractDescriptor(valueNode);
        const field: ConfigField = {
          name: fieldName,
          inferredType: desc.inferredType,
          hasDefault: desc.hasDefault,
          ...(desc.hasDefault ? { defaultValue: desc.defaultValue } : {}),
          required: desc.required,
          ...(desc.description !== undefined ? { description: desc.description } : {}),
          ...(Object.keys(desc.metadata).length > 0 ? { metadata: desc.metadata } : {}),
          source: { file: filePath, line },
        };
        fields.push(field);
      } else {
        // Nested config group — recurse with dotted prefix
        const nested = extractFieldsFromMongooseObject(valueNode, filePath, fieldName, constMap);
        fields.push(...nested);
      }
    } else {
      // Other value (literal, call expression, array, etc.) — record as unknown with default
      const dr = extractDefaultValue(valueNode);
      fields.push({
        name: fieldName,
        inferredType: "unknown",
        hasDefault: dr.hasDefault,
        ...(dr.hasDefault ? { defaultValue: dr.defaultValue } : {}),
        required: undefined,
        source: { file: filePath, line },
      });
    }
  }

  return fields;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract the integrator settings schema from Mongoose model source files.
 *
 * Targets `const settings = { ..., integrator: { ... }, ... }` and extracts
 * all fields from the `integrator:` block, resolving shorthand property
 * references and identifier-value references to top-level const definitions.
 *
 * @param files Array of source files to process (typically just `setting.ts`)
 * @returns Extracted schemas and any per-file errors
 */
export async function extractMongooseSettingsSchema(
  files: { path: string; content: string }[],
): Promise<ConfigSchemaExtractionResult> {
  await initTreeSitter();

  const schemas: ConfigSchema[] = [];
  const errors: { file: string; error: string }[] = [];

  for (const { path, content } of files) {
    try {
      const tree = parseSource(content, path);
      const root = tree.rootNode;

      const integratorBlock = findIntegratorBlock(root);
      if (!integratorBlock) {
        // No `const settings = { integrator: ... }` found — skip silently
        continue;
      }

      const constMap = buildConstMap(root);
      const fields = extractFieldsFromMongooseObject(integratorBlock, path, "", constMap);

      const schema: ConfigSchema = {
        integratorType: "__integrator_settings__",
        fields,
        sourceFiles: [path],
      };
      schemas.push(schema);
    } catch (err) {
      errors.push({
        file: path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { schemas, errors };
}
