import { describe, it, expect } from "vitest";
import { buildSettingsConstraintSet } from "./settings-constraint-builder.js";
import type { ConfigSchema, CredentialAccess } from "./types.js";

describe("buildSettingsConstraintSet", () => {
  it("returns constraint set with correct integratorType", () => {
    const result = buildSettingsConstraintSet(undefined, []);
    expect(result.integratorType).toBe("__integrator_settings__");
  });

  it("builds fields from schema only (no accesses)", () => {
    const schema: ConfigSchema = {
      integratorType: "__integrator_settings__",
      fields: [
        {
          name: "requireLock",
          inferredType: "boolean",
          hasDefault: true,
          defaultValue: false,
          required: false,
          source: { file: "setting.ts", line: 1 },
        },
        {
          name: "lockExpiryInMinutes",
          inferredType: "number",
          hasDefault: true,
          defaultValue: 10,
          required: false,
          source: { file: "setting.ts", line: 5 },
        },
      ],
      sourceFiles: ["setting.ts"],
    };

    const result = buildSettingsConstraintSet(schema, []);

    expect(result.fields).toHaveLength(2);
    const requireLock = result.fields.find((f) => f.field === "requireLock");
    expect(requireLock).toBeDefined();
    // schema required:false → never
    expect(requireLock?.required).toBe("never");
    expect(requireLock?.defaultValue).toBe(false);
    expect(requireLock?.inferredType).toBe("boolean");
  });

  it("builds fields from accesses only (no schema)", () => {
    const accesses: readonly CredentialAccess[] = [
      {
        field: "requireLock",
        file: "integrator-manager.js",
        line: 100,
        accessKind: "read",
        hasDefault: false,
        guardConditions: [],
      },
    ];

    const result = buildSettingsConstraintSet(undefined, accesses);

    expect(result.fields).toHaveLength(1);
    const requireLock = result.fields.find((f) => f.field === "requireLock");
    expect(requireLock).toBeDefined();
    // unconditional read, no default → always
    expect(requireLock?.required).toBe("always");
    expect(requireLock?.evidence).toEqual([
      { file: "integrator-manager.js", line: 100 },
    ]);
  });

  it("merges schema and accesses — evidence from both sources", () => {
    const schema: ConfigSchema = {
      integratorType: "__integrator_settings__",
      fields: [
        {
          name: "requireLock",
          inferredType: "boolean",
          hasDefault: false,
          required: undefined,
          source: { file: "setting.ts", line: 1 },
        },
      ],
      sourceFiles: ["setting.ts"],
    };
    const accesses: readonly CredentialAccess[] = [
      {
        field: "requireLock",
        file: "integrator-manager.js",
        line: 100,
        accessKind: "read",
        hasDefault: false,
        guardConditions: [],
      },
    ];

    const result = buildSettingsConstraintSet(schema, accesses);

    const requireLock = result.fields.find((f) => f.field === "requireLock");
    expect(requireLock).toBeDefined();
    // Evidence includes both schema source and access site
    expect(requireLock?.evidence).toContainEqual({ file: "setting.ts", line: 1 });
    expect(requireLock?.evidence).toContainEqual({
      file: "integrator-manager.js",
      line: 100,
    });
  });

  it("filters out write accesses", () => {
    const accesses: readonly CredentialAccess[] = [
      {
        field: "requireLock",
        file: "integrator-manager.js",
        line: 100,
        accessKind: "write",
        hasDefault: false,
        guardConditions: [],
      },
      {
        field: "lockExpiryInMinutes",
        file: "integrator-manager.js",
        line: 110,
        accessKind: "read",
        hasDefault: false,
        guardConditions: [],
      },
    ];

    const result = buildSettingsConstraintSet(undefined, accesses);

    // Only the read access contributes
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]?.field).toBe("lockExpiryInMinutes");
    // Write access excluded from coverage
    expect(result.coverage.totalAccesses).toBe(1);
  });

  it("coverage counts reflect only non-write accesses", () => {
    const accesses: readonly CredentialAccess[] = [
      {
        field: "fieldA",
        file: "a.js",
        line: 1,
        accessKind: "read",
        hasDefault: false,
        guardConditions: [],
      },
      {
        field: "fieldB",
        file: "b.js",
        line: 2,
        accessKind: "default-fallback",
        hasDefault: true,
        guardConditions: [],
      },
      {
        field: "fieldC",
        file: "c.js",
        line: 3,
        accessKind: "write",
        hasDefault: false,
        guardConditions: [],
      },
    ];

    const result = buildSettingsConstraintSet(undefined, accesses);

    expect(result.coverage.totalAccesses).toBe(2);
    expect(result.coverage.resolvedAccesses).toBe(2);
    expect(result.coverage.unresolvedAccesses).toBe(0);
  });
});
