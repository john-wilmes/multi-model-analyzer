import type {
  ConfigSchema,
  CredentialAccess,
  ConstraintSet,
} from "./types.js";
import { buildFieldConstraints } from "./constraint-builder.js";

// Tests: account-settings-constraint-builder.test.ts

/**
 * Build a single ConstraintSet for account-level settings.
 *
 * Account settings (scheduler, cancellation, communication, timezone, etc.)
 * are global — one schema applies to all accounts. All accesses are merged
 * into a single constraint set.
 */
export function buildAccountSettingsConstraintSet(
  schema: ConfigSchema | undefined,
  accesses: readonly CredentialAccess[],
): ConstraintSet {
  const nonWriteAccesses = accesses.filter((a) => a.accessKind !== "write");

  const fields = buildFieldConstraints(schema, nonWriteAccesses);

  return {
    integratorType: "__account_settings__",
    fields,
    dynamicAccesses: [],
    coverage: {
      totalAccesses: nonWriteAccesses.length,
      resolvedAccesses: nonWriteAccesses.length,
      unresolvedAccesses: 0,
    },
  };
}
