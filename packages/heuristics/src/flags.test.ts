import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter, parseSource } from "@mma/parsing";
import type { TreeSitterTree } from "@mma/parsing";
import { scanForFlags } from "./flags.js";

function makeFiles(entries: Record<string, string>): Map<string, TreeSitterTree> {
  const map = new Map<string, TreeSitterTree>();
  for (const [path, code] of Object.entries(entries)) {
    map.set(path, parseSource(code, path));
  }
  return map;
}

describe("scanForFlags", () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 15_000);

  it("detects process.env feature flags", () => {
    const files = makeFiles({
      "src/config.ts": `
        const enabled = process.env.FEATURE_NEW_UI;
        const flagB = process.env.FF_DARK_MODE;
      `,
    });
    const result = scanForFlags(files, "repo");

    const names = result.flags.map((f) => f.name);
    expect(names).toContain("FEATURE_NEW_UI");
    expect(names).toContain("FF_DARK_MODE");
  });

  it("ignores non-flag env vars", () => {
    const files = makeFiles({
      "src/config.ts": `
        const port = process.env.PORT;
        const dbUrl = process.env.DATABASE_URL;
      `,
    });
    const result = scanForFlags(files, "repo");
    expect(result.flags).toHaveLength(0);
  });

  it("detects ENABLE_ and IS_*_ENABLED patterns", () => {
    const files = makeFiles({
      "src/config.ts": `
        const a = process.env.ENABLE_CACHE;
        const b = process.env.IS_BETA_ENABLED;
      `,
    });
    const result = scanForFlags(files, "repo");
    expect(result.flags.length).toBe(2);
  });

  it("detects SDK-based flags with LaunchDarkly import", () => {
    const files = makeFiles({
      "src/feature.ts": `
        import { LDClient } from "launchdarkly-node-server-sdk";
        const val = client.variation("new-checkout-flow", user, false);
      `,
    });
    const result = scanForFlags(files, "repo");
    const ld = result.flags.find((f) => f.name === "new-checkout-flow");
    expect(ld).toBeDefined();
    expect(ld!.sdk).toBe("variation");
  });

  it("returns empty flags for code without feature flags", () => {
    const files = makeFiles({
      "src/math.ts": `export function add(a: number, b: number) { return a + b; }`,
    });
    const result = scanForFlags(files, "repo");
    expect(result.flags).toHaveLength(0);
  });

  it("merges flags from multiple files", () => {
    const files = makeFiles({
      "src/a.ts": `const x = process.env.FEATURE_ALPHA;`,
      "src/b.ts": `const y = process.env.FEATURE_ALPHA;`,
    });
    const result = scanForFlags(files, "repo");
    const alpha = result.flags.find((f) => f.name === "FEATURE_ALPHA");
    expect(alpha).toBeDefined();
    expect(alpha!.locations).toHaveLength(2);
  });

  it("excludes flags from test files", () => {
    const files = makeFiles({
      "src/config.test.ts": `const x = process.env.FEATURE_ALPHA;`,
      "src/config.spec.ts": `const y = process.env.FEATURE_BETA;`,
      "__tests__/setup.ts": `const z = process.env.FF_GAMMA;`,
    });
    const result = scanForFlags(files, "repo");
    expect(result.flags).toHaveLength(0);
  });

  it("excludes flags from test setup and fixture files", () => {
    const files = makeFiles({
      "test/helpers.ts": `const a = process.env.FEATURE_X;`,
      "jest.config.ts": `const b = process.env.ENABLE_COVERAGE;`,
      "vitest.config.ts": `const c = process.env.FEATURE_Y;`,
      "src/test.setup.ts": `const d = process.env.FF_Z;`,
      "test/fixtures/flags.ts": `const e = process.env.FEATURE_W;`,
      "src/__mocks__/env.ts": `const f = process.env.FLAG_MOCK;`,
    });
    const result = scanForFlags(files, "repo");
    expect(result.flags).toHaveLength(0);
  });

  it("keeps flags from production files alongside test files", () => {
    const files = makeFiles({
      "src/config.ts": `const x = process.env.FEATURE_ALPHA;`,
      "src/config.test.ts": `const y = process.env.FEATURE_ALPHA;`,
    });
    const result = scanForFlags(files, "repo");
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]!.locations).toHaveLength(1);
    expect(result.flags[0]!.locations[0]!.module).toBe("src/config.ts");
  });

  it("detects custom pattern flags", () => {
    const files = makeFiles({
      "src/app.ts": `const flag = getFlag("experiment_checkout_v2");`,
    });
    const result = scanForFlags(files, "repo", {
      customPatterns: [/^experiment_/],
    });
    expect(result.flags.some((f) => f.name === "experiment_checkout_v2")).toBe(true);
  });

  it("detects rollout flags with direct string literal", () => {
    const files = makeFiles({
      "src/service.ts": `
        this.isRolledOut(rootAccount, 'queue-manager');
        addRollout(userId, 'beta-feature');
      `,
    });
    const result = scanForFlags(files, "repo");
    const names = result.flags.map((f) => f.name);
    expect(names).toContain("queue-manager");
    expect(names).toContain("beta-feature");
  });

  it("detects rollout flags via variable reference", () => {
    const files = makeFiles({
      "src/service.ts": `
        const FEATURE_FLAG = 'my-flag';
        isRolledOut(userId, FEATURE_FLAG);
      `,
    });
    const result = scanForFlags(files, "repo");
    const names = result.flags.map((f) => f.name);
    expect(names).toContain("my-flag");
  });

  it("detects rollout flags via this.CLASS_CONSTANT", () => {
    const files = makeFiles({
      "src/manager.ts": `
        class QueueManager {
          private readonly QUEUE_MANAGER_ROLLOUT_KEY = 'queue-manager';
          check(rootAccount: string) {
            return this.isRolledOut(rootAccount, this.QUEUE_MANAGER_ROLLOUT_KEY);
          }
        }
      `,
    });
    const result = scanForFlags(files, "repo");
    const names = result.flags.map((f) => f.name);
    expect(names).toContain("queue-manager");
  });

  it("detects rollout flags when flag name is 2nd of 3 args (isUserRolledOut)", () => {
    const files = makeFiles({
      "src/service.ts": `
        isUserRolledOut(orgId, userId, 'multi-arg-flag');
      `,
    });
    const result = scanForFlags(files, "repo");
    const names = result.flags.map((f) => f.name);
    expect(names).toContain("multi-arg-flag");
  });

  // -- Config-driven options --

  it("detects extra SDK methods via sdkMethods option", () => {
    const files = makeFiles({
      "src/feature.ts": `
        import { Client } from "launchdarkly-node-server-sdk";
        const val = client.checkFlag("custom-flag", user, false);
      `,
    });
    // Without sdkMethods: checkFlag is not detected
    const without = scanForFlags(files, "repo");
    expect(without.flags.find((f) => f.name === "custom-flag")).toBeUndefined();

    // With sdkMethods: checkFlag is detected
    const withOpt = scanForFlags(files, "repo", { sdkMethods: ["checkFlag"] });
    const flag = withOpt.flags.find((f) => f.name === "custom-flag");
    expect(flag).toBeDefined();
    expect(flag!.sdk).toBe("checkFlag");
  });

  it("detects extra hook patterns via hookPatterns option", () => {
    const files = makeFiles({
      "src/component.tsx": `
        const isOn = useRolloutFlag("dark-mode");
      `,
    });
    // Without hookPatterns: useRolloutFlag is not detected
    const without = scanForFlags(files, "repo");
    expect(without.flags.find((f) => f.name === "dark-mode")).toBeUndefined();

    // With hookPatterns: useRolloutFlag is detected
    const withOpt = scanForFlags(files, "repo", { hookPatterns: ["useRolloutFlag"] });
    const flag = withOpt.flags.find((f) => f.name === "dark-mode");
    expect(flag).toBeDefined();
    expect(flag!.sdk).toBe("useRolloutFlag");
  });

  it("uses custom rolloutCallMethods to detect non-default rollout functions", () => {
    const files = makeFiles({
      "src/service.ts": `
        checkRollout(userId, 'custom-rollout');
      `,
    });
    // Without custom methods: not detected
    const without = scanForFlags(files, "repo");
    expect(without.flags.find((f) => f.name === "custom-rollout")).toBeUndefined();

    // With custom methods: detected
    const withOpt = scanForFlags(files, "repo", { rolloutCallMethods: ["checkRollout"] });
    const flag = withOpt.flags.find((f) => f.name === "custom-rollout");
    expect(flag).toBeDefined();
    expect(flag!.sdk).toBe("checkRollout");
  });

  it("uses custom flagPropertyName for includes-based detection", () => {
    const files = makeFiles({
      "src/service.ts": `
        if (user.rollouts.includes('my-rollout')) {}
      `,
    });
    // Default flagPropertyName ("featureFlags") does not match "rollouts"
    const without = scanForFlags(files, "repo");
    expect(without.flags.find((f) => f.name === "my-rollout")).toBeUndefined();

    // Custom flagPropertyName matches
    const withOpt = scanForFlags(files, "repo", { flagPropertyName: "rollouts" });
    const flag = withOpt.flags.find((f) => f.name === "my-rollout");
    expect(flag).toBeDefined();
  });

  it("uses custom sdkImports to trigger SDK scanning for non-default packages", () => {
    const files = makeFiles({
      "src/feature.ts": `
        import { client } from "my-custom-flag-sdk";
        const val = client.variation("custom-sdk-flag", user, false);
      `,
    });
    // Without sdkImports: my-custom-flag-sdk not recognized
    const without = scanForFlags(files, "repo");
    expect(without.flags.find((f) => f.name === "custom-sdk-flag")).toBeUndefined();

    // With sdkImports: detected
    const withOpt = scanForFlags(files, "repo", { sdkImports: ["my-custom-flag-sdk"] });
    const flag = withOpt.flags.find((f) => f.name === "custom-sdk-flag");
    expect(flag).toBeDefined();
  });
});
