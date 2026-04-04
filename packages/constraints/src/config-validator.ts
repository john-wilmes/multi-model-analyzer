// config-validator.ts — validates a runtime config document against a ConstraintSet

import type {
  ConstraintSet,
  FieldConstraint,
  GuardCondition,
  ValidationResult,
  Violation,
  SuggestedChange,
} from "./types.js";

/**
 * Walk a dotted path into a nested object, returning undefined if any segment
 * is missing or non-object.
 */
function getConfigValue(config: Record<string, unknown>, field: string): unknown {
  // Check for exact flat key first (handles dotted keys like "auth.username")
  if (Object.prototype.hasOwnProperty.call(config, field)) {
    return config[field];
  }
  const parts = field.split('.');
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Coerce a guard's string value to match the runtime value's type.
 * AST extraction always stores guard values as strings (e.g., "2", "false", "null"),
 * so we infer the intended type from the runtime value to enable correct comparison.
 */
function coerceGuardValue(guardValue: string | undefined, runtimeValue: unknown): unknown {
  if (guardValue === undefined) return undefined;
  switch (typeof runtimeValue) {
    case 'number': {
      const n = Number(guardValue);
      return Number.isNaN(n) ? guardValue : n;
    }
    case 'boolean':
      if (guardValue === 'true') return true;
      if (guardValue === 'false') return false;
      return guardValue;
    default:
      if (runtimeValue === null && guardValue === 'null') return null;
      return guardValue;
  }
}

/**
 * Evaluate a single GuardCondition against the runtime config.
 * Returns true if the guard is satisfied, false if not, or null when the
 * operator is unsupported (treated as "unknown" — doesn't trigger).
 */
function evaluateGuard(config: Record<string, unknown>, guard: GuardCondition): boolean | null {
  const value = getConfigValue(config, guard.field);

  switch (guard.operator) {
    case 'truthy':
      return guard.negated ? !value : !!value;
    case 'falsy':
      return guard.negated ? !!value : !value;
    case '==': {
      const coerced = coerceGuardValue(guard.value, value);
      return guard.negated
        ? value !== coerced
        : value === coerced;
    }
    case '!=': {
      const coerced = coerceGuardValue(guard.value, value);
      return guard.negated
        ? value === coerced
        : value !== coerced;
    }
    case 'typeof':
      return guard.negated
        ? typeof value !== String(guard.value)
        : typeof value === String(guard.value);
    default:
      // '||', '&&' — too complex to evaluate statically
      return null;
  }
}

/**
 * Determine whether a conditional field's condition set is met.
 * A condition is met when ALL its guards are satisfied.
 */
function isConditionMet(
  config: Record<string, unknown>,
  guards: readonly GuardCondition[],
): boolean {
  for (const guard of guards) {
    const result = evaluateGuard(config, guard);
    // If any guard is unknown or false, this condition set is not fully met
    if (result === null || result === false) return false;
  }
  return true;
}

function checkTypeViolation(
  field: FieldConstraint,
  value: unknown,
): Violation | null {
  const expected = field.inferredType;
  if (!expected || expected === 'unknown') return null;

  let matches: boolean;
  switch (expected) {
    case 'string':
      matches = typeof value === 'string';
      break;
    case 'number':
      matches = typeof value === 'number';
      break;
    case 'boolean':
      matches = typeof value === 'boolean';
      break;
    case 'array':
      matches = Array.isArray(value);
      break;
    case 'object':
      matches = typeof value === 'object' && !Array.isArray(value) && value !== null;
      break;
    default:
      matches = true;
  }

  if (!matches) {
    return {
      field: field.field,
      kind: 'unexpected-type',
      detail: `Expected type '${expected}' but got '${Array.isArray(value) ? 'array' : typeof value}'`,
      evidence: field.evidence,
    };
  }
  return null;
}

/**
 * Collect all dotted paths from a (possibly nested) config object.
 */
function collectPaths(obj: unknown, prefix: string): string[] {
  if (obj === null || obj === undefined || typeof obj !== 'object' || Array.isArray(obj)) {
    return prefix ? [prefix] : [];
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return prefix ? [prefix] : [];
  }
  const paths: string[] = [];
  for (const key of keys) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const child = record[key];
    if (child !== null && child !== undefined && typeof child === 'object' && !Array.isArray(child)) {
      paths.push(...collectPaths(child, fullKey));
    } else {
      paths.push(fullKey);
    }
  }
  return paths;
}

function buildNearestValid(
  actionableViolations: Violation[],
  constraintIndex: Map<string, FieldConstraint>,
): { readonly changes: readonly SuggestedChange[]; readonly distance: number } {
  const changes: SuggestedChange[] = [];

  for (const v of actionableViolations) {
    const fc = constraintIndex.get(v.field);
    if (v.kind === 'missing-required' || v.kind === 'missing-conditional') {
      changes.push({
        field: v.field,
        action: 'add',
        suggestion: fc?.defaultValue,
      });
    } else if (v.kind === 'unexpected-type') {
      changes.push({
        field: v.field,
        action: 'set',
        suggestion: fc?.defaultValue,
      });
    }
    else if (v.kind === 'unknown-field') {
      changes.push({
        field: v.field,
        action: 'remove',
        suggestion: undefined,
      });
    }
  }

  return { changes, distance: changes.length };
}

/**
 * Validate a runtime config document against a ConstraintSet.
 *
 * @param config         Flat or nested credential/config object from MongoDB
 * @param constraintSet  ConstraintSet produced by Phase 3
 * @returns ValidationResult with violations and optional nearest-valid suggestion
 */
export function validateConfig(
  config: Record<string, unknown>,
  constraintSet: ConstraintSet,
): ValidationResult {
  const violations: Violation[] = [];

  // Index constraint fields for O(1) lookup
  const constraintIndex = new Map<string, FieldConstraint>();
  // Collect intermediate path segments that are containers (e.g. for "a.b.c", add "a" and "a.b")
  const knownContainerPaths = new Set<string>();
  for (const fc of constraintSet.fields) {
    constraintIndex.set(fc.field, fc);
    const parts = fc.field.split(".");
    for (let i = 1; i < parts.length; i++) {
      knownContainerPaths.add(parts.slice(0, i).join("."));
    }
  }

  // --- Check each constrained field ---
  for (const fc of constraintSet.fields) {
    const value = getConfigValue(config, fc.field);
    const isPresent = value !== undefined;

    if (fc.required === 'always') {
      if (!isPresent) {
        violations.push({
          field: fc.field,
          kind: 'missing-required',
          detail: `Field '${fc.field}' is always required but is missing`,
          evidence: fc.evidence,
        });
      } else {
        const typeViolation = checkTypeViolation(fc, value);
        if (typeViolation) violations.push(typeViolation);
      }
    } else if (fc.required === 'conditional') {
      if (fc.conditions && fc.conditions.length > 0) {
        // Check if any condition set is met
        const metConditions = fc.conditions.filter((cond) =>
          isConditionMet(config, cond.requiredWhen),
        );
        if (metConditions.length > 0 && !isPresent) {
          const evidence = metConditions.flatMap((cond) => [...cond.evidence]);
          violations.push({
            field: fc.field,
            kind: 'missing-conditional',
            detail: `Field '${fc.field}' is conditionally required and a triggering condition is met, but the field is missing`,
            evidence: evidence.length > 0 ? evidence : fc.evidence,
          });
        } else if (isPresent) {
          const typeViolation = checkTypeViolation(fc, value);
          if (typeViolation) violations.push(typeViolation);
        }
      } else if (isPresent) {
        const typeViolation = checkTypeViolation(fc, value);
        if (typeViolation) violations.push(typeViolation);
      }
      // Conditional with no conditions and field absent — informational, skip
    } else {
      // required === 'never' — field has a default; check type if present
      if (isPresent) {
        const typeViolation = checkTypeViolation(fc, value);
        if (typeViolation) violations.push(typeViolation);
      }
    }
  }

  // --- Check for unknown fields in config ---
  // collectPaths returns only leaf paths; we need to also check intermediate containers.
  // For each leaf path, walk up the ancestors to find the shallowest unknown ancestor so
  // nearestValid can suggest removing the top-level key rather than a deeply nested leaf.
  const allConfigPaths = collectPaths(config, '');

  // Build the set of unknown leaf paths
  const unknownLeafPaths = new Set<string>();
  for (const path of allConfigPaths) {
    if (!constraintIndex.has(path) && !knownContainerPaths.has(path)) {
      unknownLeafPaths.add(path);
    }
  }

  // Collapse nested unknown paths: if a leaf's ancestor is also unknown (i.e. not a
  // known constraint or container), report only the shallowest unknown ancestor.
  // This ensures nearestValid suggests "remove extra" rather than "remove extra.nested",
  // which would leave { extra: {} } — still invalid.
  const collapsedUnknownPaths = new Set<string>();
  for (const path of unknownLeafPaths) {
    const segments = path.split('.');
    let shallowest = path;
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join('.');
      if (!constraintIndex.has(ancestor) && !knownContainerPaths.has(ancestor)) {
        shallowest = ancestor;
        break;
      }
    }
    collapsedUnknownPaths.add(shallowest);
  }

  for (const path of collapsedUnknownPaths) {
    violations.push({
      field: path,
      kind: 'unknown-field',
      detail: `Field '${path}' is not in the constraint set (may be valid but was not seen in static analysis)`,
      evidence: [],
    });
  }

  // --- Compute nearestValid ---
  const nearestValid =
    violations.length > 0
      ? buildNearestValid(violations, constraintIndex)
      : undefined;

  return {
    valid: violations.length === 0,
    violations,
    nearestValid,
    coverage: constraintSet.coverage,
  };
}
