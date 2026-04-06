import { describe, it, expect } from "vitest";
import { buildAccountSettingsConstraintSet } from "./account-settings-constraint-builder.js";
import type { ConfigSchema, CredentialAccess } from "./types.js";

describe("buildAccountSettingsConstraintSet", () => {
  it("returns constraint set with correct integratorType", () => {
    const result = buildAccountSettingsConstraintSet(undefined, []);
    expect(result.integratorType).toBe("__account_settings__");
  });

  it("builds fields from schema only (no accesses)", () => {
    const schema: ConfigSchema = {
      integratorType: "__account_settings__",
      fields: [
        {
          name: "timezone",
          inferredType: "string",
          hasDefault: true,
          defaultValue: "US/Pacific",
          required: false,
          source: { file: "setting.ts", line: 1 },
        },
        {
          name: "scheduler.appointmentDuration",
          inferredType: "number",
          hasDefault: true,
          defaultValue: 30,
          required: false,
          source: { file: "setting.ts", line: 5 },
        },
      ],
      sourceFiles: ["setting.ts"],
    };

    const result = buildAccountSettingsConstraintSet(schema, []);

    expect(result.fields).toHaveLength(2);
    const tz = result.fields.find((f) => f.field === "timezone");
    expect(tz).toBeDefined();
    expect(tz?.required).toBe("never");
    expect(tz?.defaultValue).toBe("US/Pacific");
    expect(tz?.inferredType).toBe("string");
  });

  it("builds fields from accesses only (no schema)", () => {
    const accesses: readonly CredentialAccess[] = [
      {
        field: "scheduler.appointmentDuration",
        file: "routes/scheduling.js",
        line: 42,
        accessKind: "read",
        hasDefault: false,
        guardConditions: [],
      },
    ];

    const result = buildAccountSettingsConstraintSet(undefined, accesses);

    expect(result.fields).toHaveLength(1);
    const dur = result.fields.find((f) => f.field === "scheduler.appointmentDuration");
    expect(dur).toBeDefined();
    expect(dur?.required).toBe("always");
    expect(dur?.evidence).toEqual([{ file: "routes/scheduling.js", line: 42 }]);
  });

  it("merges schema and accesses", () => {
    const schema: ConfigSchema = {
      integratorType: "__account_settings__",
      fields: [
        {
          name: "timezone",
          inferredType: "string",
          hasDefault: false,
          required: undefined,
          source: { file: "setting.ts", line: 1 },
        },
      ],
      sourceFiles: ["setting.ts"],
    };
    const accesses: readonly CredentialAccess[] = [
      {
        field: "timezone",
        file: "routes/handler.js",
        line: 10,
        accessKind: "read",
        hasDefault: false,
        guardConditions: [],
      },
    ];

    const result = buildAccountSettingsConstraintSet(schema, accesses);

    const tz = result.fields.find((f) => f.field === "timezone");
    expect(tz?.evidence).toContainEqual({ file: "setting.ts", line: 1 });
    expect(tz?.evidence).toContainEqual({ file: "routes/handler.js", line: 10 });
  });

  it("filters out write accesses", () => {
    const accesses: readonly CredentialAccess[] = [
      {
        field: "timezone",
        file: "routes/admin.js",
        line: 5,
        accessKind: "write",
        hasDefault: false,
        guardConditions: [],
      },
      {
        field: "scheduler.appointmentDuration",
        file: "routes/scheduling.js",
        line: 10,
        accessKind: "read",
        hasDefault: false,
        guardConditions: [],
      },
    ];

    const result = buildAccountSettingsConstraintSet(undefined, accesses);

    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]?.field).toBe("scheduler.appointmentDuration");
    expect(result.coverage.totalAccesses).toBe(1);
  });

  it("coverage counts reflect only non-write accesses", () => {
    const accesses: readonly CredentialAccess[] = [
      {
        field: "timezone",
        file: "a.js",
        line: 1,
        accessKind: "read",
        hasDefault: false,
        guardConditions: [],
      },
      {
        field: "scheduler.bufferTime",
        file: "b.js",
        line: 2,
        accessKind: "default-fallback",
        hasDefault: true,
        guardConditions: [],
      },
      {
        field: "communication.smsEnabled",
        file: "c.js",
        line: 3,
        accessKind: "write",
        hasDefault: false,
        guardConditions: [],
      },
    ];

    const result = buildAccountSettingsConstraintSet(undefined, accesses);

    expect(result.coverage.totalAccesses).toBe(2);
    expect(result.coverage.resolvedAccesses).toBe(2);
    expect(result.coverage.unresolvedAccesses).toBe(0);
  });
});
