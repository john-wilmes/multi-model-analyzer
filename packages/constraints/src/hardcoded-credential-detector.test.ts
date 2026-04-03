import { describe, it, expect } from "vitest";
import { detectHardcodedCredentialDefaults } from "./hardcoded-credential-detector.js";
import type { ConstraintSet } from "./types.js";

// All credential values used here are entirely synthetic/fake — no real secrets.

function makeCS(
  integratorType: string,
  fields: Array<{
    field: string;
    required?: "always" | "conditional" | "never";
    defaultValue?: unknown;
    inferredType?: string;
  }>,
): ConstraintSet {
  return {
    integratorType,
    fields: fields.map((f) => ({
      field: f.field,
      required: f.required ?? "never",
      ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
      ...(f.inferredType !== undefined ? { inferredType: f.inferredType } : {}),
      evidence: [{ file: `/clients/${integratorType}/index.ts`, line: 42 }],
    })),
    dynamicAccesses: [],
    coverage: { totalAccesses: 1, resolvedAccesses: 1, unresolvedAccesses: 0 },
  };
}

/** Assert exactly one result and return it (throws a helpful error if not). */
function expectOne(results: ReturnType<typeof detectHardcodedCredentialDefaults>) {
  expect(results).toHaveLength(1);
  const r = results[0];
  if (r === undefined) throw new Error("results[0] is undefined");
  return r;
}

describe("detectHardcodedCredentialDefaults", () => {
  it("detects a password field with a real-looking default", () => {
    const cs = makeCS("fakeehr", [
      { field: "password", defaultValue: "s3cretP@ss123" },
    ]);
    const result = expectOne(detectHardcodedCredentialDefaults([cs]));
    expect(result.ruleId).toBe("config/hardcoded-credential-default");
    expect(result.level).toBe("warning");
  });

  it("detects apiKey with a long hex-like string default", () => {
    const cs = makeCS("fakeehr", [
      { field: "apiKey", defaultValue: "abc123def456" },
    ]);
    const result = expectOne(detectHardcodedCredentialDefaults([cs]));
    expect(result.ruleId).toBe("config/hardcoded-credential-default");
  });

  it("does NOT flag a password field with empty string default", () => {
    const cs = makeCS("fakeehr", [
      { field: "password", defaultValue: "" },
    ]);
    expect(detectHardcodedCredentialDefaults([cs])).toHaveLength(0);
  });

  it("does NOT flag a password field with placeholder default 'changeme'", () => {
    const cs = makeCS("fakeehr", [
      { field: "password", defaultValue: "changeme" },
    ]);
    expect(detectHardcodedCredentialDefaults([cs])).toHaveLength(0);
  });

  it("does NOT flag a password field with placeholder default 'TODO'", () => {
    const cs = makeCS("fakeehr", [
      { field: "password", defaultValue: "TODO" },
    ]);
    expect(detectHardcodedCredentialDefaults([cs])).toHaveLength(0);
  });

  it("does NOT flag non-credential fields (e.g. syncRange with numeric default)", () => {
    const cs = makeCS("fakeehr", [
      { field: "syncRange", defaultValue: 30 },
    ]);
    expect(detectHardcodedCredentialDefaults([cs])).toHaveLength(0);
  });

  it("does NOT flag a non-credential string field", () => {
    const cs = makeCS("fakeehr", [
      { field: "serverUrl", defaultValue: "https://api.example.com" },
    ]);
    expect(detectHardcodedCredentialDefaults([cs])).toHaveLength(0);
  });

  it("does NOT flag fields without a defaultValue", () => {
    const cs = makeCS("fakeehr", [
      { field: "password" /* no defaultValue */ },
    ]);
    expect(detectHardcodedCredentialDefaults([cs])).toHaveLength(0);
  });

  it("does NOT flag boolean defaults on credential-like fields", () => {
    const cs = makeCS("fakeehr", [
      { field: "token", defaultValue: false },
    ]);
    expect(detectHardcodedCredentialDefaults([cs])).toHaveLength(0);
  });

  it("does NOT flag numeric defaults on credential-like fields", () => {
    const cs = makeCS("fakeehr", [
      { field: "apikey", defaultValue: 0 },
    ]);
    expect(detectHardcodedCredentialDefaults([cs])).toHaveLength(0);
  });

  it("returns the correct SARIF structure", () => {
    const cs = makeCS("fakeehr", [
      { field: "clientSecret", defaultValue: "fakeSuperSecret99" },
    ]);
    const result = expectOne(detectHardcodedCredentialDefaults([cs]));
    expect(result.ruleId).toBe("config/hardcoded-credential-default");
    expect(result.level).toBe("warning");
    expect(result.message.text).toContain("fakeehr");
    expect(result.message.text).toContain("clientSecret");
    expect(result.locations).toBeDefined();
    const logLoc = result.locations?.[0]?.logicalLocations?.[0];
    expect(logLoc?.fullyQualifiedName).toBe("fakeehr/clientSecret");
  });

  it("sets defaultValueLength in properties but does NOT include the actual secret", () => {
    const fakeSecret = "fakeSuperSecret99";
    const cs = makeCS("fakeehr", [
      { field: "password", defaultValue: fakeSecret },
    ]);
    const result = expectOne(detectHardcodedCredentialDefaults([cs]));
    const props = result.properties as Record<string, unknown>;
    expect(props.defaultValueLength).toBe(fakeSecret.length);
    // The actual secret value must NOT appear in properties
    expect(JSON.stringify(props)).not.toContain(fakeSecret);
  });

  it("handles multiple constraint sets and produces findings across types", () => {
    const cs1 = makeCS("fakeehr1", [
      { field: "password", defaultValue: "fakePass1!" },
    ]);
    const cs2 = makeCS("fakeehr2", [
      { field: "apiKey", defaultValue: "fakeApiKey999" },
      { field: "syncMode", defaultValue: "bidirectional" }, // not a credential
    ]);
    const results = detectHardcodedCredentialDefaults([cs1, cs2]);
    expect(results).toHaveLength(2);
    const types = results.map((r) => (r.properties as Record<string, unknown>).integratorType);
    expect(types).toContain("fakeehr1");
    expect(types).toContain("fakeehr2");
  });

  it("includes physical location from evidence when available", () => {
    const cs = makeCS("fakeehr", [
      { field: "accessToken", defaultValue: "fakeAccessTok42" },
    ]);
    const result = expectOne(detectHardcodedCredentialDefaults([cs]));
    const physLoc = result.locations?.[0]?.physicalLocation;
    expect(physLoc).toBeDefined();
    expect(physLoc?.artifactLocation.uri).toContain("fakeehr");
    expect(physLoc?.region?.startLine).toBe(42);
  });

  it("does NOT flag username with a short default (< 4 chars)", () => {
    const cs = makeCS("fakeehr", [
      { field: "username", defaultValue: "adm" }, // only 3 chars
    ]);
    expect(detectHardcodedCredentialDefaults([cs])).toHaveLength(0);
  });

  it("flags username with a default of 4+ chars that is not a placeholder", () => {
    const cs = makeCS("fakeehr", [
      { field: "username", defaultValue: "fakeadmin" },
    ]);
    expectOne(detectHardcodedCredentialDefaults([cs]));
  });

  it("handles empty input", () => {
    expect(detectHardcodedCredentialDefaults([])).toHaveLength(0);
  });

  it("handles constraint set with no fields", () => {
    const cs: ConstraintSet = {
      integratorType: "emptytype",
      fields: [],
      dynamicAccesses: [],
      coverage: { totalAccesses: 0, resolvedAccesses: 0, unresolvedAccesses: 0 },
    };
    expect(detectHardcodedCredentialDefaults([cs])).toHaveLength(0);
  });
});
