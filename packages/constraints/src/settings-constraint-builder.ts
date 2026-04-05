import type {
  ConfigSchema,
  CredentialAccess,
  ConstraintSet,
} from "./types.js";
import { buildFieldConstraints } from "./constraint-builder.js";

// Tests: settings-constraint-builder.test.ts

/**
 * Build a single ConstraintSet for integrator settings.
 *
 * Unlike credential constraints (per-integrator-type), integrator settings
 * are global — one schema applies to all integrator types. All accesses
 * are merged into a single constraint set.
 */
export function buildSettingsConstraintSet(
  schema: ConfigSchema | undefined,
  accesses: readonly CredentialAccess[],
): ConstraintSet {
  // Filter to non-write accesses
  const nonWriteAccesses = accesses.filter((a) => a.accessKind !== "write");

  const fields = buildFieldConstraints(schema, nonWriteAccesses);

  return {
    integratorType: "__integrator_settings__",
    fields,
    dynamicAccesses: [],
    coverage: {
      totalAccesses: nonWriteAccesses.length,
      resolvedAccesses: nonWriteAccesses.length,
      unresolvedAccesses: 0,
    },
  };
}
