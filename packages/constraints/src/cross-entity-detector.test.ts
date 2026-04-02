import { describe, it, expect } from "vitest";
import { detectCrossEntityDependencies } from "./cross-entity-detector.js";
import type { CredentialAccess } from "./types.js";
import type { FieldExtractor } from "./ast-utils.js";

// Mock extractors that recognize their domain's field access patterns.
// FieldExtractor signature: (text: string) => { field: string } | null
const credentialExtractor: FieldExtractor = (text) => {
  const m = /\.credentials\.(\w+)/.exec(text);
  return m && m[1] ? { field: m[1] } : null;
};
const settingsExtractor: FieldExtractor = (text) => {
  const m = /\.settings\.(\w+)/.exec(text);
  return m && m[1] ? { field: m[1] } : null;
};
const accountSettingsExtractor: FieldExtractor = (text) => {
  const m = /\.accountSettings\.(\w+)/.exec(text);
  return m && m[1] ? { field: m[1] } : null;
};

const domainExtractors = {
  credentials: credentialExtractor,
  settings: settingsExtractor,
  accountSettings: accountSettingsExtractor,
};

function makeAccess(overrides: Partial<CredentialAccess> & { field: string }): CredentialAccess {
  return {
    file: "clients/foo/service.js",
    line: 1,
    accessKind: "read",
    hasDefault: false,
    guardConditions: [],
    ...overrides,
  };
}

describe("detectCrossEntityDependencies", () => {
  it("returns empty result for all-empty inputs", () => {
    const result = detectCrossEntityDependencies([], [], [], domainExtractors);
    expect(result.dependencies).toHaveLength(0);
    expect(result.stats.totalAccesses).toBe(0);
    expect(result.stats.crossEntityAccesses).toBe(0);
  });

  it("produces no dependencies when accesses have no rawGuardTexts", () => {
    const credAccess = makeAccess({ field: "apiKey" });
    const settingsAccess = makeAccess({ field: "useFoo" });
    const result = detectCrossEntityDependencies(
      [credAccess],
      [settingsAccess],
      [],
      domainExtractors,
    );
    expect(result.dependencies).toHaveLength(0);
    expect(result.stats.totalAccesses).toBe(2);
    expect(result.stats.crossEntityAccesses).toBe(0);
  });

  it("produces no dependencies when rawGuardTexts is an empty array", () => {
    const credAccess = makeAccess({ field: "apiKey", rawGuardTexts: [] });
    const result = detectCrossEntityDependencies([credAccess], [], [], domainExtractors);
    expect(result.dependencies).toHaveLength(0);
    expect(result.stats.crossEntityAccesses).toBe(0);
  });

  it("detects single cross-entity dependency: credential guarded by settings field", () => {
    const credAccess = makeAccess({
      field: "apiKey",
      rawGuardTexts: ["self.options.integrator.settings.useFoo"],
    });
    const result = detectCrossEntityDependencies([credAccess], [], [], domainExtractors);

    expect(result.dependencies).toHaveLength(1);
    const dep = result.dependencies[0]!;
    expect(dep.accessedDomain).toBe("credentials");
    expect(dep.accessedField).toBe("apiKey");
    expect(dep.guard.domain).toBe("integrator-settings");
    expect(dep.guard.field).toBe("useFoo");
    expect(dep.guard.operator).toBe("truthy");
    expect(dep.guard.negated).toBe(false);
    expect(result.stats.crossEntityAccesses).toBe(1);
    expect(result.stats.totalAccesses).toBe(1);
  });

  it("detects single cross-entity dependency: credential guarded by account settings field", () => {
    const credAccess = makeAccess({
      field: "secret",
      rawGuardTexts: ["self.options.integrator.accountSettings.featureEnabled"],
    });
    const result = detectCrossEntityDependencies([credAccess], [], [], domainExtractors);

    expect(result.dependencies).toHaveLength(1);
    const dep = result.dependencies[0]!;
    expect(dep.accessedDomain).toBe("credentials");
    expect(dep.accessedField).toBe("secret");
    expect(dep.guard.domain).toBe("account-settings");
    expect(dep.guard.field).toBe("featureEnabled");
  });

  it("deduplicates accesses with same field and rawGuardText into one dependency with multiple evidence entries", () => {
    const access1 = makeAccess({
      field: "apiKey",
      file: "clients/foo/service.js",
      line: 10,
      rawGuardTexts: ["self.options.integrator.settings.useFoo"],
    });
    const access2 = makeAccess({
      field: "apiKey",
      file: "clients/foo/other.js",
      line: 20,
      rawGuardTexts: ["self.options.integrator.settings.useFoo"],
    });
    const result = detectCrossEntityDependencies([access1, access2], [], [], domainExtractors);

    expect(result.dependencies).toHaveLength(1);
    const dep = result.dependencies[0]!;
    expect(dep.evidence).toHaveLength(2);
    expect(dep.evidence).toContainEqual({ file: "clients/foo/service.js", line: 10 });
    expect(dep.evidence).toContainEqual({ file: "clients/foo/other.js", line: 20 });
    expect(result.stats.crossEntityAccesses).toBe(2);
  });

  it("extracts integratorType from vendor path: clients/ecw/vendors/ecw10e/service.js", () => {
    const credAccess = makeAccess({
      field: "apiKey",
      file: "clients/ecw/vendors/ecw10e/service.js",
      rawGuardTexts: ["self.options.integrator.settings.useFoo"],
    });
    const result = detectCrossEntityDependencies([credAccess], [], [], domainExtractors);

    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]!.integratorType).toBe("ecw10e");
  });

  it("extracts integratorType from base client path: clients/myehr/service.js", () => {
    const credAccess = makeAccess({
      field: "token",
      file: "clients/myehr/service.js",
      rawGuardTexts: ["self.options.integrator.settings.active"],
    });
    const result = detectCrossEntityDependencies([credAccess], [], [], domainExtractors);

    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]!.integratorType).toBe("myehr");
  });

  it("sets integratorType null for settings domain accesses regardless of file path", () => {
    const settingsAccess = makeAccess({
      field: "useFoo",
      file: "clients/myehr/service.js",
      rawGuardTexts: ["self.options.integrator.credentials.apiKey"],
    });
    const result = detectCrossEntityDependencies([], [settingsAccess], [], domainExtractors);

    expect(result.dependencies).toHaveLength(1);
    const dep = result.dependencies[0]!;
    expect(dep.accessedDomain).toBe("integrator-settings");
    expect(dep.guard.domain).toBe("credentials");
    expect(dep.integratorType).toBeNull();
  });

  it("sets integratorType null for account-settings domain accesses regardless of file path", () => {
    const accountAccess = makeAccess({
      field: "featureEnabled",
      file: "clients/myehr/service.js",
      rawGuardTexts: ["self.options.integrator.credentials.apiKey"],
    });
    const result = detectCrossEntityDependencies([], [], [accountAccess], domainExtractors);

    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]!.integratorType).toBeNull();
    expect(result.dependencies[0]!.accessedDomain).toBe("account-settings");
  });

  it("produces no dependency when rawGuardText is not recognized by any domain extractor", () => {
    const credAccess = makeAccess({
      field: "apiKey",
      rawGuardTexts: ["self.options.integrator.something.unknown"],
    });
    const result = detectCrossEntityDependencies([credAccess], [], [], domainExtractors);

    expect(result.dependencies).toHaveLength(0);
    expect(result.stats.crossEntityAccesses).toBe(0);
  });

  it("does not match guard text against the access's own domain extractor", () => {
    // A credential access guarded by another credential field should NOT produce a dependency —
    // the detector only tests guard texts against the OTHER domains' extractors.
    const credAccess = makeAccess({
      field: "proxyHost",
      rawGuardTexts: ["self.options.integrator.credentials.useProxy"],
    });
    const result = detectCrossEntityDependencies([credAccess], [], [], domainExtractors);

    expect(result.dependencies).toHaveLength(0);
    expect(result.stats.crossEntityAccesses).toBe(0);
  });

  it("counts totalAccesses across all three domains", () => {
    const credAccess = makeAccess({ field: "apiKey" });
    const settingsAccess = makeAccess({ field: "useFoo" });
    const accountAccess = makeAccess({ field: "flag" });
    const result = detectCrossEntityDependencies(
      [credAccess],
      [settingsAccess],
      [accountAccess],
      domainExtractors,
    );

    expect(result.stats.totalAccesses).toBe(3);
  });

  it("handles multiple rawGuardTexts on one access, detecting the first recognized guard", () => {
    const credAccess = makeAccess({
      field: "apiKey",
      rawGuardTexts: [
        "self.options.integrator.something.unknown",
        "self.options.integrator.settings.useFoo",
      ],
    });
    const result = detectCrossEntityDependencies([credAccess], [], [], domainExtractors);

    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]!.guard.field).toBe("useFoo");
    expect(result.stats.crossEntityAccesses).toBe(1);
  });

  it("detects dependencies across all three domain combinations in one call", () => {
    const credGuardedBySettings = makeAccess({
      field: "apiKey",
      rawGuardTexts: ["self.options.integrator.settings.useFoo"],
    });
    const settingsGuardedByAccount = makeAccess({
      field: "useFoo",
      rawGuardTexts: ["self.options.integrator.accountSettings.featureEnabled"],
    });
    const accountGuardedByCred = makeAccess({
      field: "featureEnabled",
      rawGuardTexts: ["self.options.integrator.credentials.apiKey"],
    });

    const result = detectCrossEntityDependencies(
      [credGuardedBySettings],
      [settingsGuardedByAccount],
      [accountGuardedByCred],
      domainExtractors,
    );

    expect(result.dependencies).toHaveLength(3);
    const accessedDomains = result.dependencies.map((d) => d.accessedDomain).sort();
    expect(accessedDomains).toEqual(["account-settings", "credentials", "integrator-settings"]);
    expect(result.stats.crossEntityAccesses).toBe(3);
    expect(result.stats.totalAccesses).toBe(3);
  });

  it("records correct evidence file and line for each dependency", () => {
    const credAccess = makeAccess({
      field: "apiKey",
      file: "clients/acme/vendors/acme-v2/client.js",
      line: 42,
      rawGuardTexts: ["self.options.integrator.settings.useFoo"],
    });
    const result = detectCrossEntityDependencies([credAccess], [], [], domainExtractors);

    expect(result.dependencies).toHaveLength(1);
    const dep = result.dependencies[0]!;
    expect(dep.evidence).toHaveLength(1);
    expect(dep.evidence[0]).toEqual({
      file: "clients/acme/vendors/acme-v2/client.js",
      line: 42,
    });
  });
});
