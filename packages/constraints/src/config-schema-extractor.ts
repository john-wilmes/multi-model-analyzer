import { initTreeSitter, parseSource } from "@mma/parsing";
import type { TreeSitterNode } from "@mma/parsing";
import type { ConfigField, ConfigSchema, ConfigSchemaExtractionResult } from "./types.js";

// ─── Shared descriptor-parsing utilities (exported for mongoose-schema-extractor) ──

export const TYPE_CONSTRUCTOR_MAP: Record<string, ConfigField["inferredType"]> = {
  String: "string",
  Number: "number",
  Boolean: "boolean",
  Array: "array",
  Object: "object",
};

export function inferTypeFromConstructor(text: string): ConfigField["inferredType"] {
  return TYPE_CONSTRUCTOR_MAP[text] ?? "unknown";
}

export type DefaultResult =
  | { hasDefault: false; defaultValue?: undefined }
  | { hasDefault: true; defaultValue: unknown };

export function extractDefaultValue(node: TreeSitterNode): DefaultResult {
  switch (node.type) {
    case "string":
    case "template_string": {
      const raw = node.text;
      const inner = raw.slice(1, -1);
      return { hasDefault: true, defaultValue: inner };
    }
    case "number":
      return { hasDefault: true, defaultValue: Number(node.text) };
    case "true":
      return { hasDefault: true, defaultValue: true };
    case "false":
      return { hasDefault: true, defaultValue: false };
    case "null":
      return { hasDefault: true, defaultValue: null };
    case "undefined":
      return { hasDefault: false };
    case "array":
      if (node.namedChildren.length === 0) {
        return { hasDefault: true, defaultValue: [] };
      }
      return { hasDefault: true, defaultValue: "[complex]" };
    case "object":
      if (node.namedChildren.length === 0) {
        return { hasDefault: true, defaultValue: {} };
      }
      return { hasDefault: true, defaultValue: "[complex]" };
    default:
      return { hasDefault: true, defaultValue: "[complex]" };
  }
}

export interface DescriptorResult {
  inferredType: ConfigField["inferredType"];
  hasDefault: boolean;
  defaultValue?: unknown;
  required: boolean | undefined;
  description?: string;
  metadata: Record<string, unknown>;
}

const KNOWN_DESCRIPTOR_KEYS = new Set(["type", "required", "default", "description"]);

export function extractDescriptor(objectNode: TreeSitterNode): DescriptorResult {
  let inferredType: ConfigField["inferredType"] = "unknown";
  let hasDefault = false;
  let defaultValue: unknown;
  let required: boolean | undefined;
  let description: string | undefined;
  const metadata: Record<string, unknown> = {};

  for (const child of objectNode.namedChildren) {
    if (child.type !== "pair") continue;

    const keyNode = child.children[0];
    const valueNode = child.children[2];
    if (!keyNode || !valueNode) continue;

    const key = keyNode.text.replace(/^["']|["']$/g, "");

    switch (key) {
      case "type": {
        if (valueNode.type === "identifier") {
          inferredType = inferTypeFromConstructor(valueNode.text);
        }
        break;
      }
      case "required": {
        if (valueNode.type === "true") required = true;
        else if (valueNode.type === "false") required = false;
        break;
      }
      case "default": {
        const dr = extractDefaultValue(valueNode);
        hasDefault = dr.hasDefault;
        defaultValue = dr.defaultValue;
        break;
      }
      case "description": {
        if (valueNode.type === "string" || valueNode.type === "template_string") {
          description = valueNode.text.slice(1, -1);
        } else {
          description = valueNode.text;
        }
        break;
      }
      default: {
        if (!KNOWN_DESCRIPTOR_KEYS.has(key)) {
          if (valueNode.type === "true") metadata[key] = true;
          else if (valueNode.type === "false") metadata[key] = false;
          else if (valueNode.type === "number") metadata[key] = Number(valueNode.text);
          else if (valueNode.type === "string" || valueNode.type === "template_string") {
            metadata[key] = valueNode.text.slice(1, -1);
          } else {
            metadata[key] = valueNode.text;
          }
        }
        break;
      }
    }
  }

  return { inferredType, hasDefault, defaultValue, required, description, metadata };
}

export function looksLikeDescriptor(objectNode: TreeSitterNode): boolean {
  for (const child of objectNode.namedChildren) {
    if (child.type !== "pair") continue;
    const keyNode = child.children[0];
    const valueNode = child.children[2];
    if (!keyNode || !valueNode) continue;
    const key = keyNode.text.replace(/^["']|["']$/g, "");
    if (
      key === "type" &&
      valueNode.type === "identifier" &&
      valueNode.text in TYPE_CONSTRUCTOR_MAP
    ) {
      return true;
    }
  }
  return false;
}

// ─── Integrator type name from file path ─────────────────────────────────────

function integratorTypeFromPath(filePath: string): string {
  // clients/{type}/vendors/{vendor}/context/configuration.ts
  const vendorMatch = filePath.match(
    /clients\/([^/]+)\/vendors\/([^/]+)\/context\/configuration\.ts$/,
  );
  if (vendorMatch) {
    return vendorMatch[2]!;
  }
  // clients/{type}/context/configuration.ts
  const clientMatch = filePath.match(/clients\/([^/]+)\/context\/configuration\.ts$/);
  if (clientMatch) {
    return clientMatch[1]!;
  }
  // Fallback: parent directory name relative to context/
  const parts = filePath.split("/");
  const idx = parts.indexOf("context");
  if (idx > 0) {
    return parts[idx - 1] ?? "unknown";
  }
  return parts[parts.length - 2] ?? "unknown";
}

// ─── Recursive field extraction ───────────────────────────────────────────────

function extractFieldsFromObject(
  objectNode: TreeSitterNode,
  filePath: string,
  prefix: string,
): { fields: ConfigField[]; extendsType: string | undefined } {
  const fields: ConfigField[] = [];
  let extendsType: string | undefined;

  for (const child of objectNode.namedChildren) {
    if (child.type === "spread_element") {
      // Pattern 3: vendor spread — record source identifier as extendsType
      if (!extendsType) {
        const inner = child.namedChild(0);
        if (inner?.type === "identifier") {
          extendsType = inner.text;
        }
      }
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
      // Pattern 1: bare type constructor (e.g., `username: String`)
      const inferredType = inferTypeFromConstructor(valueNode.text);
      fields.push({
        name: fieldName,
        inferredType,
        hasDefault: false,
        required: undefined,
        source: { file: filePath, line },
      });
    } else if (valueNode.type === "object") {
      if (looksLikeDescriptor(valueNode)) {
        // Pattern 2: descriptor object (e.g., `{ type: Number, default: 4, required: false }`)
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
        const nested = extractFieldsFromObject(valueNode, filePath, fieldName);
        fields.push(...nested.fields);
        if (!extendsType && nested.extendsType) {
          extendsType = nested.extendsType;
        }
      }
    } else {
      // Other value (literal, call expression, etc.) — record as unknown with default
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

  return { fields, extendsType };
}

// ─── Locate the exported config object in the AST ────────────────────────────

const CONFIG_VAR_NAMES = new Set(["configuration", "clientConfiguration"]);

function findConfigObject(root: TreeSitterNode): TreeSitterNode | null {
  for (const stmt of root.namedChildren) {
    if (stmt.type !== "export_statement") continue;
    const decl = stmt.namedChildren.find(
      (c) => c.type === "lexical_declaration" || c.type === "variable_declaration",
    );
    if (!decl) continue;
    for (const declarator of decl.namedChildren) {
      if (declarator.type !== "variable_declarator") continue;
      const nameNode = declarator.childForFieldName("name");
      const valueNode = declarator.childForFieldName("value");
      if (nameNode && CONFIG_VAR_NAMES.has(nameNode.text) && valueNode) {
        // Direct object literal
        if (valueNode.type === "object") return valueNode;
        // `{ ... } satisfies Type` — unwrap satisfies_expression
        if (valueNode.type === "satisfies_expression") {
          const inner = valueNode.namedChildren.find((c) => c.type === "object");
          if (inner) return inner;
        }
      }
    }
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function extractConfigSchemas(
  files: { path: string; content: string }[],
): Promise<ConfigSchemaExtractionResult> {
  await initTreeSitter();

  const schemas: ConfigSchema[] = [];
  const errors: { file: string; error: string }[] = [];

  for (const { path, content } of files) {
    try {
      const tree = parseSource(content, path);
      const configObject = findConfigObject(tree.rootNode);

      if (!configObject) {
        // No recognized configuration export — skip silently.
        continue;
      }

      const integratorType = integratorTypeFromPath(path);
      const { fields, extendsType } = extractFieldsFromObject(configObject, path, "");

      const schema: ConfigSchema = {
        integratorType,
        fields,
        sourceFiles: [path],
        ...(extendsType !== undefined ? { extendsType } : {}),
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
