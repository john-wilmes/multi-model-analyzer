import { describe, it, expect } from "vitest";
import { buildConstraintSets } from "./constraint-builder.js";
import type { ConfigSchema, CredentialAccess } from "./types.js";

// Helpers to build test fixtures concisely
function makeSchema(
  integratorType: string,
  fields: Array<{
    name: string;
    required?: boolean;
    hasDefault?: boolean;
    defaultValue?: unknown;
    inferredType?: ConfigSchema["fields"][number]["inferredType"];
  }>,
): ConfigSchema {
  return {
    integratorType,
    fields: fields.map((f) => ({
      name: f.name,
      required: f.required,
      hasDefault: f.hasDefault ?? false,
      defaultValue: f.defaultValue,
      inferredType: f.inferredType ?? "string",
      source: { file: `/clients/${integratorType}/config.ts`, line: 1 },
    })),
    sourceFiles: [`/clients/${integratorType}/config.ts`],
  };
}

function makeAccess(
  integratorType: string,
  field: string,
  opts: Partial<Pick<CredentialAccess, "accessKind" | "hasDefault" | "guardConditions">> = {},
): CredentialAccess {
  return {
    field,
    file: `/clients/${integratorType}/index.ts`,
    line: 10,
    accessKind: opts.accessKind ?? "read",
    hasDefault: opts.hasDefault ?? false,
    guardConditions: opts.guardConditions ?? [],
  };
}

/** Assert a constraint set exists and return it (throws otherwise). */
function getCS(result: ReturnType<typeof buildConstraintSets>, index: number) {
  const cs = result.constraintSets[index];
  if (cs === undefined) throw new Error(`constraintSets[${index}] is undefined`);
  return cs;
}

describe("buildConstraintSets", () => {
  it("empty input → empty result", () => {
    const result = buildConstraintSets([], []);
    expect(result.constraintSets).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("schema-only (no accesses) → fields from schema with requirement based on required/default", () => {
    const schemas = [
      makeSchema("typeA", [
        { name: "apiKey", required: true },
        { name: "timeout", hasDefault: true, defaultValue: 30 },
        { name: "mode", required: false },
        { name: "endpoint" }, // no required, no default
      ]),
    ];
    const result = buildConstraintSets(schemas, []);
    expect(result.constraintSets).toHaveLength(1);
    const cs = getCS(result, 0);
    expect(cs.integratorType).toBe("typeA");

    const byName = Object.fromEntries(cs.fields.map((f) => [f.field, f]));
    expect(byName["apiKey"]?.required).toBe("always");
    expect(byName["timeout"]?.required).toBe("never");
    expect(byName["mode"]?.required).toBe("never");
    expect(byName["endpoint"]?.required).toBe("never");
  });

  it("accesses-only (no schema) → fields from accesses, always if unconditional", () => {
    const accesses = [
      makeAccess("typeB", "username"),
      makeAccess("typeB", "password"),
    ];
    const result = buildConstraintSets([], accesses);
    expect(result.constraintSets).toHaveLength(1);
    const cs = getCS(result, 0);
    const byName = Object.fromEntries(cs.fields.map((f) => [f.field, f]));
    expect(byName["username"]?.required).toBe("always");
    expect(byName["password"]?.required).toBe("always");
  });

  it("merge: field with default in schema + unconditional access → never (default takes priority)", () => {
    const schemas = [makeSchema("typeC", [{ name: "apiKey", hasDefault: true, defaultValue: "" }])];
    const accesses = [makeAccess("typeC", "apiKey")];
    const result = buildConstraintSets(schemas, accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "apiKey");
    expect(field?.required).toBe("never");
    expect(field?.defaultValue).toBe("");
  });

  it("merge: field without default + unconditional access → always", () => {
    const schemas = [makeSchema("typeD", [{ name: "apiKey" }])];
    const accesses = [makeAccess("typeD", "apiKey")];
    const result = buildConstraintSets(schemas, accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "apiKey");
    expect(field?.required).toBe("always");
  });

  it("merge: field with all guarded accesses → conditional with guard conditions populated", () => {
    const guardCond = {
      field: "mode",
      operator: "==" as const,
      value: "advanced",
      negated: false,
    };
    const schemas = [makeSchema("typeE", [{ name: "advancedKey" }])];
    const accesses = [
      makeAccess("typeE", "advancedKey", { guardConditions: [guardCond] }),
      makeAccess("typeE", "advancedKey", { guardConditions: [guardCond] }),
    ];
    const result = buildConstraintSets(schemas, accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "advancedKey");
    expect(field?.required).toBe("conditional");
    expect(field?.conditions).toHaveLength(1);
    const cond = field?.conditions?.[0];
    expect(cond?.requiredWhen).toEqual([guardCond]);
    expect(cond?.evidence).toHaveLength(2);
    expect(field?.knownValues).toContain("advanced");
  });

  it("merge: field with all default-fallback accesses → never", () => {
    const schemas = [makeSchema("typeF", [{ name: "optKey" }])];
    const accesses = [
      makeAccess("typeF", "optKey", { accessKind: "default-fallback" }),
      makeAccess("typeF", "optKey", { accessKind: "default-fallback" }),
    ];
    const result = buildConstraintSets(schemas, accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "optKey");
    expect(field?.required).toBe("never");
  });

  it("merge: field explicitly required in schema (no default) → always regardless of access patterns", () => {
    const schemas = [makeSchema("typeG", [{ name: "apiKey", required: true }])];
    // All accesses are guarded — should still be 'always' because schema says required
    const guardCond = { field: "mode", operator: "truthy" as const, negated: false };
    const accesses = [makeAccess("typeG", "apiKey", { guardConditions: [guardCond] })];
    const result = buildConstraintSets(schemas, accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "apiKey");
    expect(field?.required).toBe("always");
  });

  it("schema required:true + hasDefault:true → never (default makes it self-sufficient)", () => {
    const schemas = [
      makeSchema("typeG2", [
        { name: "baseUrl", required: true, hasDefault: true, defaultValue: "https://example.com" },
        { name: "subscriberKey", required: true, hasDefault: true, defaultValue: "sandbox-key" },
        { name: "apiKey", required: true }, // no default → still always
      ]),
    ];
    const result = buildConstraintSets(schemas, []);
    const cs = getCS(result, 0);
    const byName = Object.fromEntries(cs.fields.map((f) => [f.field, f]));
    expect(byName["baseUrl"]?.required).toBe("never");
    expect(byName["subscriberKey"]?.required).toBe("never");
    expect(byName["apiKey"]?.required).toBe("always");
  });

  it("write accesses excluded from requirement determination", () => {
    const schemas = [makeSchema("typeH", [{ name: "token" }])];
    // Only write accesses — should default to never (no reads)
    const accesses = [makeAccess("typeH", "token", { accessKind: "write" })];
    const result = buildConstraintSets(schemas, accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "token");
    expect(field?.required).toBe("never");
    // Write accesses should not appear in coverage totals
    expect(cs.coverage.totalAccesses).toBe(0);
  });

  it("coverage stats are correct", () => {
    const schemas = [makeSchema("typeI", [{ name: "apiKey" }, { name: "secret" }])];
    const accesses = [
      makeAccess("typeI", "apiKey"),
      makeAccess("typeI", "apiKey"),
      makeAccess("typeI", "secret"),
      makeAccess("typeI", "secret", { accessKind: "write" }), // excluded
    ];
    const result = buildConstraintSets(schemas, accesses);
    const cs = getCS(result, 0);
    expect(cs.coverage.totalAccesses).toBe(3);
    expect(cs.coverage.resolvedAccesses).toBe(3);
    expect(cs.coverage.unresolvedAccesses).toBe(0);
  });

  it("vendor path accesses are attributed to vendor type", () => {
    const vendorAccess: CredentialAccess = {
      field: "vendorToken",
      file: "/clients/parentType/vendors/vendorX/index.ts",
      line: 5,
      accessKind: "read",
      hasDefault: false,
      guardConditions: [],
    };
    const result = buildConstraintSets([], [vendorAccess]);
    expect(result.constraintSets).toHaveLength(1);
    const cs = getCS(result, 0);
    expect(cs.integratorType).toBe("vendorX");
  });

  it("paths without leading separator (bare tree-sitter paths) are matched", () => {
    // tree-sitter paths start with "clients/" directly, not "/clients/"
    const access: CredentialAccess = {
      field: "apiKey",
      file: "clients/epic/src/index.ts",
      line: 1,
      accessKind: "read",
      hasDefault: false,
      guardConditions: [],
    };
    const result = buildConstraintSets([], [access]);
    expect(result.constraintSets).toHaveLength(1);
    expect(result.constraintSets[0]!.integratorType).toBe("epic");
  });

  it("accesses with no extractable integrator type are dropped", () => {
    const access: CredentialAccess = {
      field: "apiKey",
      file: "/some/other/path/index.ts",
      line: 1,
      accessKind: "read",
      hasDefault: false,
      guardConditions: [],
    };
    const result = buildConstraintSets([], [access]);
    expect(result.constraintSets).toHaveLength(0);
  });
});
