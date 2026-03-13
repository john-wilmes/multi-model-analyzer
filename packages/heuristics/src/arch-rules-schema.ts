/**
 * Architectural rules config loader and validator.
 *
 * Validates user-supplied rule configs from mma.config.json and converts
 * them to typed ArchitecturalRule objects.
 */

import type {
  ArchitecturalRule,
  LayerRuleConfig,
  ForbiddenImportConfig,
  DependencyDirectionConfig,
} from "@mma/core";

export interface RawArchRule {
  readonly id?: string;
  readonly description?: string;
  readonly kind?: string;
  readonly severity?: string;
  readonly config?: unknown;
}

const VALID_KINDS = new Set(["layer-violation", "forbidden-import", "dependency-direction"]);
const VALID_SEVERITIES = new Set(["error", "warning", "note"]);

export interface ValidationError {
  readonly ruleIndex: number;
  readonly field: string;
  readonly message: string;
}

export function validateArchRules(raw: readonly RawArchRule[]): {
  rules: ArchitecturalRule[];
  errors: ValidationError[];
} {
  const rules: ArchitecturalRule[] = [];
  const errors: ValidationError[] = [];

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!;

    if (!r.id || typeof r.id !== "string") {
      errors.push({ ruleIndex: i, field: "id", message: "id is required and must be a string" });
      continue;
    }
    if (!r.kind || !VALID_KINDS.has(r.kind)) {
      errors.push({ ruleIndex: i, field: "kind", message: `kind must be one of: ${[...VALID_KINDS].join(", ")}` });
      continue;
    }
    if (r.severity && !VALID_SEVERITIES.has(r.severity)) {
      errors.push({ ruleIndex: i, field: "severity", message: `severity must be one of: ${[...VALID_SEVERITIES].join(", ")}` });
      continue;
    }
    if (!r.config || typeof r.config !== "object") {
      errors.push({ ruleIndex: i, field: "config", message: "config is required and must be an object" });
      continue;
    }

    const configErrors = validateConfig(i, r.kind, r.config as Record<string, unknown>);
    if (configErrors.length > 0) {
      errors.push(...configErrors);
      continue;
    }

    rules.push({
      id: r.id,
      description: r.description ?? "",
      kind: r.kind as ArchitecturalRule["kind"],
      severity: (r.severity ?? "warning") as ArchitecturalRule["severity"],
      config: r.config as LayerRuleConfig | ForbiddenImportConfig | DependencyDirectionConfig,
    });
  }

  return { rules, errors };
}

function validateConfig(
  ruleIndex: number,
  kind: string,
  config: Record<string, unknown>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  switch (kind) {
    case "layer-violation": {
      if (!Array.isArray(config.layers)) {
        errors.push({ ruleIndex, field: "config.layers", message: "layers must be an array" });
        break;
      }
      for (let j = 0; j < config.layers.length; j++) {
        const layer = config.layers[j] as Record<string, unknown>;
        if (!layer.name || typeof layer.name !== "string") {
          errors.push({ ruleIndex, field: `config.layers[${j}].name`, message: "layer name is required" });
        }
        if (!Array.isArray(layer.patterns)) {
          errors.push({ ruleIndex, field: `config.layers[${j}].patterns`, message: "patterns must be an array of strings" });
        }
        if (!Array.isArray(layer.allowedDependencies)) {
          errors.push({ ruleIndex, field: `config.layers[${j}].allowedDependencies`, message: "allowedDependencies must be an array" });
        }
      }
      break;
    }
    case "forbidden-import": {
      if (!Array.isArray(config.from)) {
        errors.push({ ruleIndex, field: "config.from", message: "from must be an array of glob patterns" });
      }
      if (!Array.isArray(config.forbidden)) {
        errors.push({ ruleIndex, field: "config.forbidden", message: "forbidden must be an array of glob patterns" });
      }
      break;
    }
    case "dependency-direction": {
      if (!Array.isArray(config.denied)) {
        errors.push({ ruleIndex, field: "config.denied", message: "denied must be an array of [from, to] pairs" });
      }
      break;
    }
  }

  return errors;
}

/**
 * JSON Schema (draft-07) for the rules array in mma.config.json.
 */
export const ARCH_RULES_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "MMA Architectural Rules",
  description: "Configuration schema for architectural dependency rules in mma.config.json",
  type: "array",
  items: {
    type: "object",
    required: ["id", "kind", "config"],
    properties: {
      id: {
        type: "string",
        description: "Unique identifier for this rule",
      },
      description: {
        type: "string",
        description: "Human-readable description of what this rule enforces",
      },
      kind: {
        type: "string",
        enum: ["layer-violation", "forbidden-import", "dependency-direction"],
        description: "Type of architectural constraint",
      },
      severity: {
        type: "string",
        enum: ["error", "warning", "note"],
        default: "warning",
        description: "SARIF severity level for violations",
      },
      config: {
        oneOf: [
          {
            title: "LayerRuleConfig",
            type: "object",
            required: ["layers"],
            properties: {
              layers: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "patterns", "allowedDependencies"],
                  properties: {
                    name: { type: "string" },
                    patterns: { type: "array", items: { type: "string" } },
                    allowedDependencies: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          {
            title: "ForbiddenImportConfig",
            type: "object",
            required: ["from", "forbidden"],
            properties: {
              from: { type: "array", items: { type: "string" } },
              forbidden: { type: "array", items: { type: "string" } },
            },
          },
          {
            title: "DependencyDirectionConfig",
            type: "object",
            required: ["denied"],
            properties: {
              allowed: {
                type: "array",
                items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
              },
              denied: {
                type: "array",
                items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
              },
            },
          },
        ],
      },
    },
  },
} as const;
