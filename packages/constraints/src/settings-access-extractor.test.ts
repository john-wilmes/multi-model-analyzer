import { describe, it, expect, beforeAll } from "vitest";
import { extractSettingsAccesses } from "./settings-access-extractor.js";
import { initTreeSitter } from "@mma/parsing";
import type { CredentialAccess } from "./types.js";

function access(
  accesses: readonly CredentialAccess[],
  field: string,
): CredentialAccess | undefined {
  return accesses.find((a) => a.field === field);
}

describe("extractSettingsAccesses", () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 15_000);

  it("returns empty result for empty input", async () => {
    const result = await extractSettingsAccesses([]);
    expect(result.accesses).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.stats.filesScanned).toBe(0);
    expect(result.stats.filesWithAccesses).toBe(0);
    expect(result.stats.totalAccesses).toBe(0);
  });

  it("skips files with no settings accesses", async () => {
    const result = await extractSettingsAccesses([
      {
        path: "clients/foo/service.js",
        content: `
          class FooClient {
            getToken() {
              return self.options.integrator.credentials.apiToken;
            }
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.accesses).toHaveLength(0);
    expect(result.stats.filesWithAccesses).toBe(0);
  });

  it("detects self.options.integrator.settings.integrator.X", async () => {
    const result = await extractSettingsAccesses([
      {
        path: "clients/foo/service.js",
        content: `
          class FooClient {
            run() {
              return self.options.integrator.settings.integrator.syncEnabled;
            }
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.accesses).toHaveLength(1);
    const a = result.accesses[0]!;
    expect(a.field).toBe("syncEnabled");
    expect(a.accessKind).toBe("read");
    expect(a.hasDefault).toBe(false);
    expect(a.guardConditions).toHaveLength(0);
  });

  it("detects self.options.integrator.settings?.integrator?.X (optional chaining)", async () => {
    const result = await extractSettingsAccesses([
      {
        path: "clients/optchain/service.js",
        content: `
          function getWindow() {
            return self.options.integrator.settings?.integrator?.syncWindow;
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "syncWindow");
    expect(a).toBeDefined();
    expect(a!.accessKind).toBe("read");
    expect(a!.field).not.toContain("?.");
  });

  it("detects integratorObject.settings.integrator.X.Y (dotted nested paths)", async () => {
    const result = await extractSettingsAccesses([
      {
        path: "example-service/handler.js",
        content: `
          function getDays(integratorObject) {
            return integratorObject.settings.integrator.syncWindow.days;
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "syncWindow.days");
    expect(a).toBeDefined();
    expect(a!.field).toBe("syncWindow.days");
    expect(a!.accessKind).toBe("read");
  });

  it("detects _.get(integrator, 'settings.integrator.X', default) lodash pattern", async () => {
    const result = await extractSettingsAccesses([
      {
        path: "clients/lodash/service.js",
        content: `
          function getTimeout(integrator) {
            return _.get(integrator, 'settings.integrator.timeoutMs', 30000);
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "timeoutMs");
    expect(a).toBeDefined();
    expect(a!.hasDefault).toBe(true);
    expect(a!.accessKind).toBe("default-fallback");
    expect(result.stats.byPattern["lodash-get"]).toBe(1);
  });

  it("detects alias: const integratorSettings = integratorObject.settings.integrator; integratorSettings.requireLock", async () => {
    const result = await extractSettingsAccesses([
      {
        path: "example-service/handler.js",
        content: `
          function checkLock(integratorObject) {
            const integratorSettings = integratorObject.settings.integrator;
            return integratorSettings.requireLock;
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "requireLock");
    expect(a).toBeDefined();
    expect(a!.accessKind).toBe("read");
  });

  it("detects write access: integratorObject.settings.integrator.X = value", async () => {
    const result = await extractSettingsAccesses([
      {
        path: "example-service/handler.js",
        content: `
          function setFlag(integratorObject) {
            integratorObject.settings.integrator.debugMode = true;
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "debugMode");
    expect(a).toBeDefined();
    expect(a!.accessKind).toBe("write");
  });

  it("detects default fallback: integratorObject.settings.integrator.X || defaultVal", async () => {
    const result = await extractSettingsAccesses([
      {
        path: "example-service/handler.js",
        content: `
          function getRetries(integratorObject) {
            return integratorObject.settings.integrator.maxRetries || 3;
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "maxRetries");
    expect(a).toBeDefined();
    expect(a!.accessKind).toBe("default-fallback");
    expect(a!.hasDefault).toBe(true);
  });

  it("populates enclosingFunction for access inside a named function", async () => {
    const result = await extractSettingsAccesses([
      {
        path: "example-service/handler.js",
        content: `
          function syncRecords(integratorObject) {
            return integratorObject.settings.integrator.syncBatchSize;
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "syncBatchSize");
    expect(a).toBeDefined();
    expect(a!.enclosingFunction).toBe("syncRecords");
  });

  it("enclosingFunction is undefined for module-scope settings access", async () => {
    const result = await extractSettingsAccesses([
      {
        path: "example-service/config.js",
        content: `const batchSize = self.options.integrator.settings.integrator.syncBatchSize;`,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "syncBatchSize");
    expect(a).toBeDefined();
    expect(a!.enclosingFunction).toBeUndefined();
  });

  it("correctly extracts guard conditions when access is inside an if block", async () => {
    const result = await extractSettingsAccesses([
      {
        path: "clients/guard/service.js",
        content: `
          function setup() {
            if (self.options.integrator.settings.integrator.useAdvancedSync) {
              const window = self.options.integrator.settings.integrator.syncWindow;
              return window;
            }
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const syncWindow = access(result.accesses, "syncWindow");
    expect(syncWindow).toBeDefined();
    expect(syncWindow!.guardConditions).toHaveLength(1);
    const guard = syncWindow!.guardConditions[0]!;
    expect(guard.field).toBe("useAdvancedSync");
    expect(guard.operator).toBe("truthy");
    expect(guard.negated).toBe(false);
  });
});
