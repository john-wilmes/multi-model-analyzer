import type {
  ConfigSchema,
  CredentialAccess,
  FieldConstraint,
  ConstraintSet,
  ConstraintSetResult,
  RequirementLevel,
  GuardCondition,
} from "./types.js";
import { extractIntegratorTypeFromPath } from "./integrator-path-utils.js";

/**
 * Determines if an access is unconditional (no guard conditions, not a default-fallback, not a write).
 */
function isUnconditionalRead(access: CredentialAccess): boolean {
  return (
    access.guardConditions.length === 0 &&
    access.accessKind !== 'default-fallback' &&
    access.accessKind !== 'write'
  );
}

/**
 * Determines the requirement level for a field given its schema info and non-write accesses.
 */
export function determineRequirementLevel(
  fieldName: string,
  schemaRequired: boolean | undefined,
  schemaHasDefault: boolean,
  nonWriteAccesses: readonly CredentialAccess[],
): RequirementLevel {
  // Priority 1: explicitly required in schema → always (unless it has a default)
  if (schemaRequired === true) {
    // A field marked required:true with a default has a placeholder/fallback —
    // the schema author explicitly marked it required, but the default means the
    // runtime won't crash. Treat as conditional (important but has a fallback).
    if (schemaHasDefault) {
      return 'conditional';
    }
    return 'always';
  }

  // Priority 5: explicitly not required in schema → never
  if (schemaRequired === false) {
    return 'never';
  }

  // No schema required info — determine from accesses and defaults
  if (nonWriteAccesses.length > 0) {
    // Priority 4: has schema default → never
    if (schemaHasDefault) {
      return 'never';
    }

    const allHaveDefaultFallback = nonWriteAccesses.every(
      (a) => a.accessKind === 'default-fallback' || a.hasDefault,
    );

    // Priority 4: all accesses have default fallback → never
    if (allHaveDefaultFallback) {
      return 'never';
    }

    const hasUnconditionalAccess = nonWriteAccesses.some(isUnconditionalRead);

    // Priority 2: no default AND accessed unconditionally → always
    // Exception: if any access of this field has a self-referential truthy guard
    // (e.g., `if (credentials.fieldName)` guards usage of `fieldName`), the code
    // explicitly handles the undefined case → downgrade to conditional.
    if (hasUnconditionalAccess) {
      // We check across ALL accesses (not just the unconditional ones) because
      // the common ISC pattern `if (creds.field) { use(creds.field) }` produces
      // an unconditional read (the condition check itself has no guard) PLUS a
      // guarded read with a self-truthy guard (the body). Checking all accesses
      // ensures the self-truthy guard on the body correctly triggers a downgrade
      // to 'conditional', reflecting that the developer explicitly handles the
      // undefined case.
      const hasSelfTruthyGuard = nonWriteAccesses.some((a) =>
        a.guardConditions.some(
          (g) => g.field === fieldName && g.operator === 'truthy' && !g.negated,
        ),
      );
      if (hasSelfTruthyGuard) {
        return 'conditional';
      }

      // If all non-write accesses come exclusively from destructuring patterns
      // (no member_expression accesses exist), we lack downstream usage context.
      // Destructuring never throws on undefined — we can't prove the field is
      // required without seeing how the local variable is used. Downgrade to
      // 'conditional' to avoid false missing-required violations.
      const allDestructured = nonWriteAccesses.every((a) => a.isDestructured === true);
      if (allDestructured) {
        return 'conditional';
      }

      // If all unconditional accesses are inside named functions (not at module scope),
      // the field is only required when those functions are called. Without inter-procedural
      // analysis we can't prove those functions are always invoked, so downgrade to conditional.
      const unconditionalAccesses = nonWriteAccesses.filter(isUnconditionalRead);
      const allInsideFunctions = unconditionalAccesses.every(
        (a) => a.enclosingFunction !== undefined,
      );
      if (allInsideFunctions) {
        return 'conditional';
      }

      return 'always';
    }

    // Priority 3: all accesses are guarded → conditional
    return 'conditional';
  }

  // Schema-only: no accesses
  // Priority 4: schema has default → never
  if (schemaHasDefault) {
    return 'never';
  }

  // Default: never (assume optional)
  return 'never';
}

/**
 * Builds FieldConstraint objects for a given integrator type.
 */
export function buildFieldConstraints(
  schema: ConfigSchema | undefined,
  nonWriteAccesses: readonly CredentialAccess[],
): readonly FieldConstraint[] {
  // Collect all field names
  const fieldNames = new Set<string>();

  if (schema) {
    for (const f of schema.fields) {
      fieldNames.add(f.name);
    }
  }

  for (const access of nonWriteAccesses) {
    fieldNames.add(access.field);
  }

  const constraints: FieldConstraint[] = [];

  for (const fieldName of fieldNames) {
    const schemaField = schema?.fields.find((f) => f.name === fieldName);
    const fieldAccesses = nonWriteAccesses.filter((a) => a.field === fieldName);

    const required = determineRequirementLevel(
      fieldName,
      schemaField?.required,
      schemaField?.hasDefault ?? false,
      fieldAccesses,
    );

    // Collect evidence: schema source + access sites
    const evidence: { file: string; line: number }[] = [];
    if (schemaField) {
      evidence.push(schemaField.source);
    }
    for (const access of fieldAccesses) {
      evidence.push({ file: access.file, line: access.line });
    }

    // Collect known values from guard conditions (== or !=)
    const knownValuesSet = new Set<string>();
    for (const access of fieldAccesses) {
      for (const guard of access.guardConditions) {
        if ((guard.operator === '==' || guard.operator === '!=') && guard.value !== undefined) {
          knownValuesSet.add(guard.value);
        }
      }
    }
    const knownValues = knownValuesSet.size > 0 ? [...knownValuesSet] : undefined;

    // Build conditions for conditional fields
    let conditions:
      | readonly {
          readonly requiredWhen: readonly GuardCondition[];
          readonly evidence: readonly { readonly file: string; readonly line: number }[];
        }[]
      | undefined;

    if (required === 'conditional') {
      // Group accesses by guard condition set (stringified for deduplication)
      const conditionGroups = new Map<
        string,
        {
          requiredWhen: readonly GuardCondition[];
          evidence: { file: string; line: number }[];
        }
      >();

      for (const access of fieldAccesses) {
        if (access.guardConditions.length > 0) {
          const key = JSON.stringify(access.guardConditions);
          const existing = conditionGroups.get(key);
          if (existing) {
            existing.evidence.push({ file: access.file, line: access.line });
          } else {
            conditionGroups.set(key, {
              requiredWhen: access.guardConditions,
              evidence: [{ file: access.file, line: access.line }],
            });
          }
        }
      }

      conditions = [...conditionGroups.values()];
    }

    const constraint: FieldConstraint = {
      field: fieldName,
      required,
      ...(schemaField?.defaultValue !== undefined ? { defaultValue: schemaField.defaultValue } : {}),
      ...(schemaField?.inferredType !== undefined ? { inferredType: schemaField.inferredType } : {}),
      ...(schemaField?.description !== undefined ? { description: schemaField.description } : {}),
      ...(schemaField?.metadata !== undefined ? { metadata: schemaField.metadata } : {}),
      ...(conditions !== undefined ? { conditions } : {}),
      ...(knownValues !== undefined ? { knownValues } : {}),
      evidence,
    };

    constraints.push(constraint);
  }

  // Post-process: downgrade nested `always` fields whose parent is not `always`.
  // If a parent field is `conditional` or `never`, any child field cannot be
  // unconditionally required — it should be conditional on the parent being present.
  //
  // Sort by field depth (ascending) so that shallow parents are processed before
  // their children. This ensures that when `a.b` is downgraded to conditional,
  // its child `a.b.c` will see the updated parent status.
  const sortedIndices = constraints
    .map((_, i) => i)
    .sort((a, b) => {
      const depthA = (constraints[a]!.field.match(/\./g) ?? []).length;
      const depthB = (constraints[b]!.field.match(/\./g) ?? []).length;
      return depthA - depthB;
    });

  // Live lookup map — updated as we downgrade fields, so children see updated parents.
  const requirementByField = new Map(constraints.map((c) => [c.field, c.required]));

  for (const idx of sortedIndices) {
    const constraint = constraints[idx]!;
    if (constraint.required !== 'always') continue;
    const dotIndex = constraint.field.lastIndexOf('.');
    if (dotIndex === -1) continue; // not a nested field
    const parentField = constraint.field.slice(0, dotIndex);
    const parentRequired = requirementByField.get(parentField);
    if (parentRequired === undefined) continue; // parent unknown, leave as-is
    if (parentRequired === 'always') continue; // parent is always present, child can be always
    // Parent is `conditional` or `never` — child cannot be `always`
    const parentRequiredWhen: GuardCondition = {
      field: parentField,
      operator: 'truthy',
      negated: false,
    };
    const downgraded = {
      ...constraint,
      required: 'conditional' as const,
      conditions: [
        {
          requiredWhen: [parentRequiredWhen],
          evidence: constraint.evidence,
        },
      ],
    };
    constraints[idx] = downgraded;
    requirementByField.set(constraint.field, 'conditional');
  }

  return constraints;
}

/**
 * Merges ConfigSchema (Phase 1) and CredentialAccess[] (Phase 2) into ConstraintSets per integrator type.
 */
export function buildConstraintSets(
  schemas: readonly ConfigSchema[],
  accesses: readonly CredentialAccess[],
): ConstraintSetResult {
  const errors: { integratorType: string; error: string }[] = [];

  // Index schemas by integrator type
  const schemaByType = new Map<string, ConfigSchema>();
  for (const schema of schemas) {
    schemaByType.set(schema.integratorType, schema);
  }

  // Group non-write accesses by integrator type (extracted from file path)
  const accessesByType = new Map<string, CredentialAccess[]>();
  for (const access of accesses) {
    if (access.accessKind === 'write') continue;
    const integratorType = extractIntegratorTypeFromPath(access.file);
    if (integratorType !== undefined) {
      const list = accessesByType.get(integratorType) ?? [];
      list.push(access);
      accessesByType.set(integratorType, list);
    }
    // Accesses with no extractable type are dropped — can't assign to a type
  }

  // Collect all integrator types from both sources
  const allTypes = new Set<string>([...schemaByType.keys(), ...accessesByType.keys()]);

  const constraintSets: ConstraintSet[] = [];

  for (const integratorType of allTypes) {
    try {
      const schema = schemaByType.get(integratorType);
      const typeAccesses = accessesByType.get(integratorType) ?? [];

      const totalAccesses = typeAccesses.length;
      // Currently all accesses have field names (Phase 2 always extracts them)
      const resolvedAccesses = typeAccesses.length;
      const unresolvedAccesses = totalAccesses - resolvedAccesses;

      const fields = buildFieldConstraints(schema, typeAccesses);

      const constraintSet: ConstraintSet = {
        integratorType,
        fields,
        dynamicAccesses: [],
        coverage: {
          totalAccesses,
          resolvedAccesses,
          unresolvedAccesses,
        },
      };

      constraintSets.push(constraintSet);
    } catch (err) {
      errors.push({
        integratorType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { constraintSets, errors };
}
