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
  opts: Partial<Pick<CredentialAccess, "accessKind" | "hasDefault" | "guardConditions" | "isDestructured" | "enclosingFunction">> = {},
): CredentialAccess {
  return {
    field,
    file: `/clients/${integratorType}/index.ts`,
    line: 10,
    accessKind: opts.accessKind ?? "read",
    hasDefault: opts.hasDefault ?? false,
    guardConditions: opts.guardConditions ?? [],
    ...(opts.isDestructured !== undefined ? { isDestructured: opts.isDestructured } : {}),
    ...(opts.enclosingFunction !== undefined ? { enclosingFunction: opts.enclosingFunction } : {}),
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

  it("schema required:true + hasDefault:true → conditional (schema-required with placeholder default)", () => {
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
    expect(byName["baseUrl"]?.required).toBe("conditional");
    expect(byName["subscriberKey"]?.required).toBe("conditional");
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

  it("bare-constructor schema fields with function-scoped accesses → always (schema overrides function-scope downgrade)", () => {
    // Simulates oncoemrfilepickup: host/username/password are bare-constructor schema fields
    // accessed inside named functions. Without the schema inference, function-scoped access
    // downgrades them to conditional. The schema declaration is authoritative evidence that
    // the field is expected, overriding the function-scope uncertainty.
    const schemas = [
      makeSchema("typeH2", [
        { name: "host" },     // bare constructor: required undefined, no default
        { name: "username" }, // same
        { name: "password" }, // same
        { name: "path" },    // same — but accessed with self-truthy guard
      ]),
    ];
    const accesses = [
      makeAccess("typeH2", "host", { enclosingFunction: "login" }),
      makeAccess("typeH2", "username", { enclosingFunction: "login" }),
      makeAccess("typeH2", "password", { enclosingFunction: "login" }),
      // path is accessed with a self-truthy guard: if (creds.path) { use(creds.path) }
      makeAccess("typeH2", "path", { enclosingFunction: "login" }),
      makeAccess("typeH2", "path", {
        enclosingFunction: "login",
        guardConditions: [{ field: "path", operator: "truthy" as const, negated: false }],
      }),
    ];
    const result = buildConstraintSets(schemas, accesses);
    const cs = getCS(result, 0);
    const byName = Object.fromEntries(cs.fields.map((f) => [f.field, f]));
    // Schema bare-constructor overrides function-scope downgrade → always
    expect(byName["host"]?.required).toBe("always");
    expect(byName["username"]?.required).toBe("always");
    expect(byName["password"]?.required).toBe("always");
    // Self-truthy guard is developer intent to handle undefined → still conditional
    expect(byName["path"]?.required).toBe("conditional");
  });

  it("schema-implied-required fields with destructuring-only accesses → always", () => {
    const schemas = [makeSchema("typeH4", [{ name: "host" }])];
    const accesses = [
      makeAccess("typeH4", "host", { isDestructured: true }),
      makeAccess("typeH4", "host", { isDestructured: true }),
    ];
    const result = buildConstraintSets(schemas, accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "host");
    expect(field?.required).toBe("always");
  });

  it("bare-constructor schema-only fields (no accesses) → never (unused schema fields)", () => {
    // Fields declared in schema with bare constructors but NO accesses — unused/dead fields
    const schemas = [
      makeSchema("typeH3", [
        { name: "host" },
        { name: "apiKey" },
        { name: "mode", required: false },
        { name: "timeout", hasDefault: true, defaultValue: 30 },
      ]),
    ];
    const result = buildConstraintSets(schemas, []);
    const cs = getCS(result, 0);
    const byName = Object.fromEntries(cs.fields.map((f) => [f.field, f]));
    expect(byName["host"]?.required).toBe("never");
    expect(byName["apiKey"]?.required).toBe("never");
    expect(byName["mode"]?.required).toBe("never");
    expect(byName["timeout"]?.required).toBe("never");
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

  it("root-level client files (clients/type.js) are attributed correctly", () => {
    // Legacy ISC clients are single files at clients/ root, not in subdirectories
    const access: CredentialAccess = {
      field: "twoFactorAuthSecret",
      file: "clients/advancedmd.js",
      line: 39,
      accessKind: "read",
      hasDefault: false,
      guardConditions: [],
    };
    const result = buildConstraintSets([], [access]);
    expect(result.constraintSets).toHaveLength(1);
    expect(result.constraintSets[0]!.integratorType).toBe("advancedmd");
  });

  it("field with unguarded access + self-referential truthy guard → conditional (not always)", () => {
    // Simulates: `const { useLastMatchingPatientId } = credentials;` (unguarded)
    // plus: `if (credentials.useLastMatchingPatientId) { ... use it ... }` (self-truthy guard)
    const selfGuard = { field: "useLastMatchingPatientId", operator: "truthy" as const, negated: false };
    const accesses = [
      // Destructuring — no guard (would normally make it "always")
      makeAccess("typeJ", "useLastMatchingPatientId"),
      // Guarded access inside `if (credentials.useLastMatchingPatientId)`
      makeAccess("typeJ", "useLastMatchingPatientId", { guardConditions: [selfGuard] }),
      makeAccess("typeJ", "useLastMatchingPatientId", { guardConditions: [selfGuard] }),
    ];
    const result = buildConstraintSets([], accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "useLastMatchingPatientId");
    expect(field?.required).toBe("conditional");
  });

  it("field with unguarded access + non-self truthy guard → still always", () => {
    // Guard tests a DIFFERENT field, not the same one — should remain "always"
    const otherGuard = { field: "enableFeatureX", operator: "truthy" as const, negated: false };
    const accesses = [
      makeAccess("typeK", "apiEndpoint"),
      makeAccess("typeK", "apiEndpoint", { guardConditions: [otherGuard] }),
    ];
    const result = buildConstraintSets([], accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "apiEndpoint");
    expect(field?.required).toBe("always");
  });

  it("field with unguarded access + negated self-referential guard → still always", () => {
    // Guard is `if (!credentials.field)` — negated, so it doesn't prove the code handles undefined gracefully
    const negatedSelfGuard = { field: "optionalFlag", operator: "truthy" as const, negated: true };
    const accesses = [
      makeAccess("typeL", "optionalFlag"),
      makeAccess("typeL", "optionalFlag", { guardConditions: [negatedSelfGuard] }),
    ];
    const result = buildConstraintSets([], accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "optionalFlag");
    expect(field?.required).toBe("always");
  });

  it("destructuring-only field without self-truthy guard → conditional (not always)", () => {
    const accesses = [
      makeAccess("typeM", "useToggle", { isDestructured: true }),
      makeAccess("typeM", "useToggle", { isDestructured: true }),
    ];
    const result = buildConstraintSets([], accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "useToggle");
    expect(field?.required).toBe("conditional");
  });

  it("mixed destructuring + member_expression access → always (not downgraded)", () => {
    const accesses = [
      makeAccess("typeN", "url", { isDestructured: true }),
      makeAccess("typeN", "url"), // member_expression (isDestructured not set)
    ];
    const result = buildConstraintSets([], accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "url");
    expect(field?.required).toBe("always");
  });

  it("nested field with 'always' parent → child stays always", () => {
    // If epicVendorMap is always required, epicVendorMap.createReferral can be always too
    const accesses = [
      makeAccess("typeO", "epicVendorMap"),
      makeAccess("typeO", "epicVendorMap.createReferral"),
    ];
    const result = buildConstraintSets([], accesses);
    const cs = getCS(result, 0);
    const byName = Object.fromEntries(cs.fields.map((f) => [f.field, f]));
    expect(byName["epicVendorMap"]?.required).toBe("always");
    expect(byName["epicVendorMap.createReferral"]?.required).toBe("always");
  });

  it("nested field with 'never' parent → child downgraded from always to conditional", () => {
    // Parent epicVendorMap is guarded (never), so child cannot be always required
    const parentGuard = { field: "epicVendorMap", operator: "truthy" as const, negated: false };
    const accesses = [
      makeAccess("typeP", "epicVendorMap", { guardConditions: [parentGuard] }),
      // child accessed unconditionally — would be 'always' without parent check
      makeAccess("typeP", "epicVendorMap.createReferral"),
      makeAccess("typeP", "epicVendorMap.createPatientDocument"),
    ];
    const result = buildConstraintSets([], accesses);
    const cs = getCS(result, 0);
    const byName = Object.fromEntries(cs.fields.map((f) => [f.field, f]));
    // Parent is conditional (self-truthy guard)
    expect(byName["epicVendorMap"]?.required).toBe("conditional");
    // Children must be downgraded
    expect(byName["epicVendorMap.createReferral"]?.required).toBe("conditional");
    expect(byName["epicVendorMap.createPatientDocument"]?.required).toBe("conditional");
    // Conditions should reference parent field
    const cond = byName["epicVendorMap.createReferral"]?.conditions?.[0];
    expect(cond?.requiredWhen[0]?.field).toBe("epicVendorMap");
    expect(cond?.requiredWhen[0]?.operator).toBe("truthy");
  });

  it("nested field with schema 'never' parent → child downgraded from always to conditional", () => {
    // Schema marks parent as required:false → never; child accessed unconditionally
    const schemas = [
      makeSchema("typeQ", [
        { name: "useFhirVersion", required: false },
        { name: "useFhirVersion.getPatient" }, // no schema info for child
      ]),
    ];
    const accesses = [
      makeAccess("typeQ", "useFhirVersion.getPatient"),
    ];
    const result = buildConstraintSets(schemas, accesses);
    const cs = getCS(result, 0);
    const byName = Object.fromEntries(cs.fields.map((f) => [f.field, f]));
    expect(byName["useFhirVersion"]?.required).toBe("never");
    // Child unconditionally accessed but parent is never → must be conditional
    expect(byName["useFhirVersion.getPatient"]?.required).toBe("conditional");
    const cond = byName["useFhirVersion.getPatient"]?.conditions?.[0];
    expect(cond?.requiredWhen[0]?.field).toBe("useFhirVersion");
  });

  it("deeply nested field: grandparent never → child downgraded", () => {
    // a.b.c where a is never — c would be always but should be downgraded
    const parentGuard = { field: "a", operator: "truthy" as const, negated: false };
    const accesses = [
      makeAccess("typeR", "a", { guardConditions: [parentGuard] }), // a is conditional
      makeAccess("typeR", "a.b"),           // b would be always
      makeAccess("typeR", "a.b.c"),         // c would be always
    ];
    const result = buildConstraintSets([], accesses);
    const cs = getCS(result, 0);
    const byName = Object.fromEntries(cs.fields.map((f) => [f.field, f]));
    expect(byName["a"]?.required).toBe("conditional");
    // a.b parent is a (conditional) → downgraded
    expect(byName["a.b"]?.required).toBe("conditional");
    // a.b.c parent is a.b (now conditional) → also downgraded
    expect(byName["a.b.c"]?.required).toBe("conditional");
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

  it("all accesses inside named functions → conditional (function-scope downgrade)", () => {
    const accesses = [
      makeAccess("typeS", "apiKey", { enclosingFunction: "connect" }),
      makeAccess("typeS", "apiKey", { enclosingFunction: "authenticate" }),
    ];
    const result = buildConstraintSets([], accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "apiKey");
    expect(field?.required).toBe("conditional");
  });

  it("at least one module-scope access → always (not downgraded)", () => {
    const accesses = [
      makeAccess("typeT", "apiKey", { enclosingFunction: "connect" }),
      makeAccess("typeT", "apiKey"), // module scope: enclosingFunction is undefined
    ];
    const result = buildConstraintSets([], accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "apiKey");
    expect(field?.required).toBe("always");
  });

  it("mix of function-scoped and module-scope unconditional accesses → always", () => {
    const accesses = [
      makeAccess("typeU", "token", { enclosingFunction: "getToken" }),
      makeAccess("typeU", "token"), // module scope
      makeAccess("typeU", "token", { enclosingFunction: "refreshToken" }),
    ];
    const result = buildConstraintSets([], accesses);
    const cs = getCS(result, 0);
    const field = cs.fields.find((f) => f.field === "token");
    expect(field?.required).toBe("always");
  });
});
