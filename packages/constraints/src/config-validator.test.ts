// config-validator.test.ts — vitest tests for Phase 4 config validator

import { describe, it, expect } from "vitest";
import { validateConfig } from "./config-validator.js";
import type { ConstraintSet, FieldConstraint } from "./types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const evidence = [{ file: "src/integrator.ts", line: 42 }];

const coverage = { totalAccesses: 10, resolvedAccesses: 10, unresolvedAccesses: 0 };

function makeConstraintSet(fields: FieldConstraint[]): ConstraintSet {
  return {
    integratorType: "test-integrator",
    fields,
    dynamicAccesses: [],
    coverage,
  };
}

function makeAlwaysField(field: string, inferredType?: string): FieldConstraint {
  return {
    field,
    required: "always",
    inferredType: inferredType ?? "string",
    evidence,
  };
}

function makeNeverField(field: string, defaultValue?: unknown): FieldConstraint {
  return {
    field,
    required: "never",
    inferredType: "string",
    defaultValue,
    evidence,
  };
}

function makeConditionalField(
  field: string,
  guardField: string,
  guardOperator: "truthy" | "==" | "!=",
  guardValue?: string,
  negated = false,
): FieldConstraint {
  return {
    field,
    required: "conditional",
    inferredType: "string",
    evidence,
    conditions: [
      {
        requiredWhen: [
          { field: guardField, operator: guardOperator, value: guardValue, negated },
        ],
        evidence,
      },
    ],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("validateConfig", () => {
  it("valid config with all required fields → valid: true, no violations", () => {
    const cs = makeConstraintSet([
      makeAlwaysField("username"),
      makeAlwaysField("password"),
    ]);
    const result = validateConfig({ username: "admin", password: "secret" }, cs);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.nearestValid).toBeUndefined();
  });

  it("missing always-required field → violation 'missing-required'", () => {
    const cs = makeConstraintSet([makeAlwaysField("username")]);
    const result = validateConfig({}, cs);
    expect(result.valid).toBe(false);
    const v = result.violations.find((x) => x.kind === "missing-required");
    expect(v).toBeDefined();
    expect(v?.field).toBe("username");
  });

  it("missing conditional field when condition IS met → violation 'missing-conditional'", () => {
    const cs = makeConstraintSet([
      makeConditionalField("oauthToken", "useOAuth", "truthy"),
    ]);
    // useOAuth is truthy, oauthToken is absent
    const result = validateConfig({ useOAuth: true }, cs);
    expect(result.valid).toBe(false);
    const v = result.violations.find((x) => x.kind === "missing-conditional");
    expect(v).toBeDefined();
    expect(v?.field).toBe("oauthToken");
  });

  it("missing conditional field when condition is NOT met → no violation", () => {
    const cs = makeConstraintSet([
      makeConditionalField("oauthToken", "useOAuth", "truthy"),
    ]);
    // useOAuth is falsy, so condition not met
    const result = validateConfig({ useOAuth: false }, cs);
    const conditionalViolations = result.violations.filter(
      (v) => v.kind === "missing-conditional",
    );
    expect(conditionalViolations).toHaveLength(0);
  });

  it("unknown field in config → violation 'unknown-field'", () => {
    const cs = makeConstraintSet([makeAlwaysField("username")]);
    const result = validateConfig({ username: "admin", surpriseField: "oops" }, cs);
    const v = result.violations.find((x) => x.kind === "unknown-field");
    expect(v).toBeDefined();
    expect(v?.field).toBe("surpriseField");
  });

  it("type mismatch → violation 'unexpected-type'", () => {
    const cs = makeConstraintSet([makeAlwaysField("port", "number")]);
    const result = validateConfig({ port: "3000" }, cs);
    expect(result.valid).toBe(false);
    const v = result.violations.find((x) => x.kind === "unexpected-type");
    expect(v).toBeDefined();
    expect(v?.field).toBe("port");
    expect(v?.detail).toContain("number");
  });

  it("all optional (never-required) fields missing → valid", () => {
    const cs = makeConstraintSet([
      makeNeverField("timeout", 30000),
      makeNeverField("retries", 3),
    ]);
    const result = validateConfig({}, cs);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("nearestValid includes correct changes and distance", () => {
    const cs = makeConstraintSet([
      makeAlwaysField("username"),
      makeAlwaysField("password"),
    ]);
    const result = validateConfig({}, cs);
    expect(result.nearestValid).toBeDefined();
    expect(result.nearestValid?.distance).toBe(2);
    const fields = result.nearestValid?.changes.map((c) => c.field) ?? [];
    expect(fields).toContain("username");
    expect(fields).toContain("password");
    expect(result.nearestValid?.changes.every((c) => c.action === "add")).toBe(true);
  });

  it("empty config against constraints with required fields → multiple violations", () => {
    const cs = makeConstraintSet([
      makeAlwaysField("host"),
      makeAlwaysField("apiKey"),
      makeAlwaysField("orgId"),
    ]);
    const result = validateConfig({}, cs);
    expect(result.valid).toBe(false);
    const missing = result.violations.filter((v) => v.kind === "missing-required");
    expect(missing).toHaveLength(3);
  });

  it("negated guard condition: field required when guard is falsy", () => {
    // Field 'fallbackPassword' required when 'useSSOLogin' is falsy (negated truthy)
    const cs = makeConstraintSet([
      makeConditionalField("fallbackPassword", "useSSOLogin", "truthy", undefined, true),
    ]);
    // useSSOLogin is falsy/absent → negated truthy guard → condition IS met → need fallbackPassword
    const resultMissing = validateConfig({ useSSOLogin: false }, cs);
    expect(resultMissing.violations.some((v) => v.kind === "missing-conditional")).toBe(true);

    // useSSOLogin is truthy → negated truthy guard → condition NOT met → no violation
    const resultPresent = validateConfig({ useSSOLogin: true }, cs);
    expect(resultPresent.violations.filter((v) => v.kind === "missing-conditional")).toHaveLength(0);
  });

  it("coverage is passed through from the ConstraintSet", () => {
    const cs = makeConstraintSet([makeAlwaysField("username")]);
    const result = validateConfig({ username: "admin" }, cs);
    expect(result.coverage).toEqual(coverage);
  });

  it("dotted path field: nested config value resolved correctly", () => {
    const fc: FieldConstraint = {
      field: "internalLoginService.mode",
      required: "always",
      inferredType: "string",
      evidence,
    };
    const cs = makeConstraintSet([fc]);

    // Field present nested
    const resultValid = validateConfig(
      { internalLoginService: { mode: "oauth" } },
      cs,
    );
    expect(resultValid.violations.filter((v) => v.kind === "missing-required")).toHaveLength(0);

    // Field absent nested
    const resultMissing = validateConfig({ internalLoginService: {} }, cs);
    expect(resultMissing.violations.some((v) => v.kind === "missing-required")).toBe(true);
  });

  it("nearestValid includes remove action for unknown fields", () => {
    const cs = makeConstraintSet([makeAlwaysField("username")]);
    // config has unknown 'extra' and is missing 'username'
    const result = validateConfig({ extra: "data" }, cs);
    expect(result.nearestValid).toBeDefined();
    const changeFields = result.nearestValid?.changes.map((c) => c.field) ?? [];
    expect(changeFields).toContain("username");
    expect(changeFields).toContain("extra");
    const removeChange = result.nearestValid?.changes.find((c) => c.field === "extra");
    expect(removeChange?.action).toBe("remove");
    // distance counts all actionable changes
    expect(result.nearestValid?.distance).toBe(2);
  });

  it("flat dotted key in config is recognized (not treated as nested path)", () => {
    const cs = makeConstraintSet([makeAlwaysField("auth.username")]);
    // Config uses flat dotted key, not nested object
    const result = validateConfig({ "auth.username": "admin" }, cs);
    expect(result.violations.filter((v) => v.kind === "missing-required")).toHaveLength(0);
  });

  it("typeof guard operator evaluates correctly", () => {
    const cs = makeConstraintSet([
      {
        field: "apiVersion",
        required: "conditional",
        inferredType: "string",
        evidence,
        conditions: [
          {
            requiredWhen: [
              { field: "config", operator: "typeof" as const, value: "object", negated: false },
            ],
            evidence,
          },
        ],
      },
    ]);
    // config is an object → typeof guard met → apiVersion required but missing
    const resultMissing = validateConfig({ config: { key: "val" } }, cs);
    expect(resultMissing.violations.some((v) => v.kind === "missing-conditional")).toBe(true);

    // config is a string → typeof guard not met → no violation
    const resultString = validateConfig({ config: "flat" }, cs);
    expect(resultString.violations.filter((v) => v.kind === "missing-conditional")).toHaveLength(0);
  });

  it("unknown-field-only config gets nearestValid with remove changes", () => {
    const cs = makeConstraintSet([]);
    const result = validateConfig({ rogue: "value", extra: "stuff" }, cs);
    expect(result.valid).toBe(false);
    expect(result.nearestValid).toBeDefined();
    expect(result.nearestValid?.distance).toBe(2);
    expect(result.nearestValid?.changes.every((c) => c.action === "remove")).toBe(true);
  });

  it("container object for dotted-field constraint is not reported as unknown-field", () => {
    // Constraint on "internalLoginService.mode" → "internalLoginService" is a valid container
    const fc: FieldConstraint = {
      field: "internalLoginService.mode",
      required: "always",
      inferredType: "string",
      evidence,
    };
    const cs = makeConstraintSet([fc]);

    // Container exists but inner field is absent → only missing-required, no unknown-field on container
    const result = validateConfig({ internalLoginService: {} }, cs);
    const unknownViolations = result.violations.filter((v) => v.kind === "unknown-field");
    expect(unknownViolations).toHaveLength(0);
    expect(result.violations.some((v) => v.kind === "missing-required")).toBe(true);
  });

  it("empty nested object is reported as unknown-field", () => {
    const cs = makeConstraintSet([makeAlwaysField("username")]);
    const result = validateConfig({ username: "admin", extra: {} }, cs);
    const unknown = result.violations.filter((v) => v.kind === "unknown-field");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.field).toBe("extra");
  });

  it("nested unknown subtree collapses to top-level ancestor in unknown-field violation", () => {
    // { extra: { nested: 1 } } — neither 'extra' nor 'extra.nested' is a known constraint
    // Should report 'extra', not 'extra.nested', so nearestValid says "remove extra"
    // rather than "remove extra.nested" (which would leave { extra: {} }, still invalid)
    const cs = makeConstraintSet([makeAlwaysField("username")]);
    const result = validateConfig({ username: "admin", extra: { nested: 1 } }, cs);
    const unknown = result.violations.filter((v) => v.kind === "unknown-field");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.field).toBe("extra");
    // nearestValid should suggest removing 'extra', not 'extra.nested'
    const removeChange = result.nearestValid?.changes.find((c) => c.action === "remove");
    expect(removeChange?.field).toBe("extra");
  });

  it("guard == operator matches string guard value against numeric runtime value", () => {
    // Guard values from AST extraction are always strings (e.g., "2"),
    // but runtime config values can be numbers. Loose equality must be used.
    const cs = makeConstraintSet([
      makeConditionalField("extraToken", "apiVersion", "==", "2"),
    ]);
    // apiVersion is numeric 2, guard value is string "2" → should match (loose ==)
    const resultMatch = validateConfig({ apiVersion: 2 }, cs);
    expect(resultMatch.violations.some((v) => v.kind === "missing-conditional")).toBe(true);

    // apiVersion is 3 → should not match
    const resultNoMatch = validateConfig({ apiVersion: 3 }, cs);
    expect(resultNoMatch.violations.filter((v) => v.kind === "missing-conditional")).toHaveLength(0);
  });

  it("guard != operator distinguishes string guard value against numeric runtime value", () => {
    // Guard value "2" (string) vs runtime 2 (number): != should use loose inequality
    const cs = makeConstraintSet([
      makeConditionalField("legacyKey", "apiVersion", "!=", "2"),
    ]);
    // apiVersion is 3 → not equal to "2" → condition met → legacyKey required but missing
    const resultMatch = validateConfig({ apiVersion: 3 }, cs);
    expect(resultMatch.violations.some((v) => v.kind === "missing-conditional")).toBe(true);

    // apiVersion is 2 (number) == "2" (string) → condition NOT met → no violation
    const resultNoMatch = validateConfig({ apiVersion: 2 }, cs);
    expect(resultNoMatch.violations.filter((v) => v.kind === "missing-conditional")).toHaveLength(0);
  });

  it("guard == operator matches string guard value against boolean runtime value", () => {
    // Guard value "false" (string from AST) vs runtime false (boolean)
    const cs = makeConstraintSet([
      makeConditionalField("debugKey", "enabled", "==", "false"),
    ]);
    // enabled is boolean false → coerced "false" to false → matches
    const resultMatch = validateConfig({ enabled: false }, cs);
    expect(resultMatch.violations.some((v) => v.kind === "missing-conditional")).toBe(true);

    // enabled is boolean true → does not match "false"
    const resultNoMatch = validateConfig({ enabled: true }, cs);
    expect(resultNoMatch.violations.filter((v) => v.kind === "missing-conditional")).toHaveLength(0);
  });

  it("deeply nested unknown subtree collapses to shallowest unknown ancestor", () => {
    // { a: { b: { c: 1 } } } with no constraint — should report 'a'
    const cs = makeConstraintSet([]);
    const result = validateConfig({ a: { b: { c: 1 } } }, cs);
    const unknown = result.violations.filter((v) => v.kind === "unknown-field");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.field).toBe("a");
  });

  it("partially known nested path: sibling unknown collapses to sibling key", () => {
    // Constraint on "service.mode", so "service" is a known container.
    // { service: { mode: "oauth", unknown: "x" } } — "service.unknown" is not a constraint.
    // Should report "service.unknown" (not "service" which is a known container).
    const fc: FieldConstraint = {
      field: "service.mode",
      required: "always",
      inferredType: "string",
      evidence,
    };
    const cs = makeConstraintSet([fc]);
    const result = validateConfig({ service: { mode: "oauth", unknown: "x" } }, cs);
    const unknown = result.violations.filter((v) => v.kind === "unknown-field");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.field).toBe("service.unknown");
  });

  it("multiple nested unknown paths under same root collapse to single ancestor violation", () => {
    // { extra: { a: 1, b: 2 } } → should produce one violation for 'extra', not two for
    // 'extra.a' and 'extra.b'
    const cs = makeConstraintSet([makeAlwaysField("username")]);
    const result = validateConfig({ username: "admin", extra: { a: 1, b: 2 } }, cs);
    const unknown = result.violations.filter((v) => v.kind === "unknown-field");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.field).toBe("extra");
  });
});
