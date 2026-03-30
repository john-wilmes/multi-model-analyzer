import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter, parseSource } from "@mma/parsing";
import type { TreeSitterTree } from "@mma/parsing";
import { scanForSettings } from "./settings.js";

function makeFiles(entries: Record<string, string>): Map<string, TreeSitterTree> {
  const map = new Map<string, TreeSitterTree>();
  for (const [path, code] of Object.entries(entries)) {
    map.set(path, parseSource(code, path));
  }
  return map;
}

describe("scanForSettings", () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 15_000);

  it("returns empty inventory for empty input", () => {
    const result = scanForSettings(new Map(), "repo");
    expect(result.repo).toBe("repo");
    expect(result.parameters).toHaveLength(0);
  });

  it("returns empty inventory for code with no settings", () => {
    const files = makeFiles({
      "src/math.ts": `export function add(a: number, b: number) { return a + b; }`,
    });
    const result = scanForSettings(files, "repo");
    expect(result.parameters).toHaveLength(0);
  });

  it("detects config object property access", () => {
    const files = makeFiles({
      "src/app.ts": `
        const timeout = config.timeout;
        const retries = config.maxRetries;
      `,
    });
    const result = scanForSettings(files, "repo");
    const names = result.parameters.map((p) => p.name);
    expect(names).toContain("timeout");
    expect(names).toContain("maxRetries");
  });

  it("detects settings object property access", () => {
    const files = makeFiles({
      "src/app.ts": `
        const limit = settings.rateLimit;
        const host = settings.host;
      `,
    });
    const result = scanForSettings(files, "repo");
    const names = result.parameters.map((p) => p.name);
    expect(names).toContain("rateLimit");
    expect(names).toContain("host");
  });

  it("detects options and opts object property accesses", () => {
    const files = makeFiles({
      "src/client.ts": `
        const pool = options.poolSize;
        const conn = opts.connectionTimeout;
      `,
    });
    const result = scanForSettings(files, "repo");
    const names = result.parameters.map((p) => p.name);
    expect(names).toContain("poolSize");
    expect(names).toContain("connectionTimeout");
  });

  it("detects env var with known prefix as setting", () => {
    const files = makeFiles({
      "src/db.ts": `const url = process.env.DATABASE_URL;`,
    });
    const result = scanForSettings(files, "repo");
    const param = result.parameters.find((p) => p.name === "DATABASE_URL");
    expect(param).toBeDefined();
    expect(param!.kind).toBe("setting");
    expect(param!.source).toBe("process.env");
  });

  it("detects env var with API_ prefix as setting", () => {
    const files = makeFiles({
      "src/api.ts": `const baseUrl = process.env.API_BASE_URL;`,
    });
    const result = scanForSettings(files, "repo");
    const param = result.parameters.find((p) => p.name === "API_BASE_URL");
    expect(param).toBeDefined();
    expect(param!.kind).toBe("setting");
  });

  it("detects credential env var by _KEY suffix", () => {
    const files = makeFiles({
      "src/auth.ts": `const key = process.env.API_KEY;`,
    });
    const result = scanForSettings(files, "repo");
    const param = result.parameters.find((p) => p.name === "API_KEY");
    expect(param).toBeDefined();
    expect(param!.kind).toBe("credential");
  });

  it("detects credential env var by _PASSWORD suffix", () => {
    const files = makeFiles({
      "src/db.ts": `const pw = process.env.DB_PASSWORD;`,
    });
    const result = scanForSettings(files, "repo");
    const param = result.parameters.find((p) => p.name === "DB_PASSWORD");
    expect(param).toBeDefined();
    expect(param!.kind).toBe("credential");
  });

  it("detects credential env var by _SECRET suffix", () => {
    const files = makeFiles({
      "src/auth.ts": `const secret = process.env.JWT_SECRET;`,
    });
    const result = scanForSettings(files, "repo");
    const param = result.parameters.find((p) => p.name === "JWT_SECRET");
    expect(param).toBeDefined();
    expect(param!.kind).toBe("credential");
  });

  it("detects credential env var by _TOKEN suffix", () => {
    const files = makeFiles({
      "src/auth.ts": `const token = process.env.GITHUB_TOKEN;`,
    });
    const result = scanForSettings(files, "repo");
    const param = result.parameters.find((p) => p.name === "GITHUB_TOKEN");
    expect(param).toBeDefined();
    expect(param!.kind).toBe("credential");
  });

  it("skips feature flag env vars", () => {
    const files = makeFiles({
      "src/config.ts": `
        const x = process.env.FEATURE_NEW_UI;
        const y = process.env.FF_DARK_MODE;
        const z = process.env.FLAG_BETA;
        const a = process.env.ENABLE_CACHE;
      `,
    });
    const result = scanForSettings(files, "repo");
    expect(result.parameters).toHaveLength(0);
  });

  it("skips env vars without known prefix (not credentials, not known prefix)", () => {
    const files = makeFiles({
      "src/config.ts": `const port = process.env.PORT;`,
    });
    const result = scanForSettings(files, "repo");
    // PORT has no known prefix and no credential suffix — should be skipped
    expect(result.parameters.find((p) => p.name === "PORT")).toBeUndefined();
  });

  it("extracts default value from nullish coalescing operator", () => {
    const files = makeFiles({
      "src/app.ts": `const timeout = config.timeout ?? 5000;`,
    });
    const result = scanForSettings(files, "repo");
    const param = result.parameters.find((p) => p.name === "timeout");
    expect(param).toBeDefined();
    expect(param!.defaultValue).toBe(5000);
    expect(param!.valueType).toBe("number");
  });

  it("extracts string default value from nullish coalescing operator", () => {
    const files = makeFiles({
      "src/app.ts": `const host = config.host ?? 'localhost';`,
    });
    const result = scanForSettings(files, "repo");
    const param = result.parameters.find((p) => p.name === "host");
    expect(param).toBeDefined();
    expect(param!.defaultValue).toBe("localhost");
    expect(param!.valueType).toBe("string");
  });

  it("skips test files", () => {
    const files = makeFiles({
      "src/config.test.ts": `const x = config.timeout;`,
      "src/config.spec.ts": `const y = settings.maxRetries;`,
      "__tests__/setup.ts": `const z = process.env.DATABASE_URL;`,
    });
    const result = scanForSettings(files, "repo");
    expect(result.parameters).toHaveLength(0);
  });

  it("skips fixture and helper directories", () => {
    const files = makeFiles({
      "test/fixtures/db.ts": `const url = process.env.DATABASE_URL;`,
      "test/helpers/config.ts": `const x = config.timeout;`,
      "src/__mocks__/env.ts": `const y = process.env.API_KEY;`,
    });
    const result = scanForSettings(files, "repo");
    expect(result.parameters).toHaveLength(0);
  });

  it("deduplicates same setting accessed across multiple files", () => {
    const files = makeFiles({
      "src/a.ts": `const x = config.timeout;`,
      "src/b.ts": `const y = config.timeout;`,
      "src/c.ts": `const z = config.timeout;`,
    });
    const result = scanForSettings(files, "repo");
    const timeouts = result.parameters.filter((p) => p.name === "timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]!.locations).toHaveLength(3);
  });

  it("records correct repo and module in location", () => {
    const files = makeFiles({
      "src/service.ts": `const x = config.retryLimit;`,
    });
    const result = scanForSettings(files, "my-repo");
    const param = result.parameters.find((p) => p.name === "retryLimit");
    expect(param).toBeDefined();
    expect(param!.locations[0]!.repo).toBe("my-repo");
    expect(param!.locations[0]!.module).toBe("src/service.ts");
  });

  it("detects zod schema properties", () => {
    const files = makeFiles({
      "src/schema.ts": `
        import { z } from "zod";
        const schema = z.object({
          host: z.string(),
          port: z.number().min(0).max(65535),
          enabled: z.boolean(),
        });
      `,
    });
    const result = scanForSettings(files, "repo");
    const names = result.parameters.map((p) => p.name);
    expect(names).toContain("host");
    expect(names).toContain("port");
    expect(names).toContain("enabled");
  });

  it("extracts value types from zod schema", () => {
    const files = makeFiles({
      "src/schema.ts": `
        import { z } from "zod";
        const schema = z.object({
          timeout: z.number(),
          name: z.string(),
          active: z.boolean(),
        });
      `,
    });
    const result = scanForSettings(files, "repo");
    const timeout = result.parameters.find((p) => p.name === "timeout");
    const name = result.parameters.find((p) => p.name === "name");
    const active = result.parameters.find((p) => p.name === "active");
    expect(timeout?.valueType).toBe("number");
    expect(name?.valueType).toBe("string");
    expect(active?.valueType).toBe("boolean");
  });

  it("extracts range constraints from zod schema", () => {
    const files = makeFiles({
      "src/schema.ts": `
        import { z } from "zod";
        const schema = z.object({
          port: z.number().min(1).max(65535),
        });
      `,
    });
    const result = scanForSettings(files, "repo");
    const port = result.parameters.find((p) => p.name === "port");
    expect(port).toBeDefined();
    expect(port!.rangeMin).toBe(1);
    expect(port!.rangeMax).toBe(65535);
  });

  it("does not scan validator schemas when no import present", () => {
    // Without import, the object({}) detection should not fire
    const files = makeFiles({
      "src/app.ts": `
        const schema = someLib.object({
          port: someLib.number(),
        });
      `,
    });
    const result = scanForSettings(files, "repo");
    // No zod/joi import — should not detect schema properties
    expect(result.parameters.find((p) => p.name === "port")).toBeUndefined();
  });

  it("respects custom configObjectNames option", () => {
    const files = makeFiles({
      "src/app.ts": `
        const x = myConf.retryCount;
        const y = config.retryCount;
      `,
    });
    const result = scanForSettings(files, "repo", {
      configObjectNames: ["myConf"],
    });
    const names = result.parameters.map((p) => p.name);
    expect(names).toContain("retryCount");
    // Only one location (config.retryCount skipped since "config" not in custom list)
    const param = result.parameters.find((p) => p.name === "retryCount");
    expect(param!.locations).toHaveLength(1);
  });

  it("respects custom excludePaths option", () => {
    const files = makeFiles({
      "src/generated/config.ts": `const x = config.timeout;`,
      "src/app.ts": `const y = config.timeout;`,
    });
    const result = scanForSettings(files, "repo", {
      excludePaths: [/\/generated\//],
    });
    const param = result.parameters.find((p) => p.name === "timeout");
    expect(param).toBeDefined();
    expect(param!.locations).toHaveLength(1);
    expect(param!.locations[0]!.module).toBe("src/app.ts");
  });

  describe("mongoose-style config definitions", () => {
    it("detects JS assignment form with bare type identifiers", () => {
      const files = makeFiles({
        "src/client.js": `
          AthenaHealth.configuration = {
            username: String,
            skipSync: Boolean,
            maxRetries: Number,
          };
        `,
      });
      const result = scanForSettings(files, "repo");
      expect(result.parameters).toHaveLength(3);
      expect(result.parameters.find(p => p.name === "username")).toMatchObject({
        valueType: "string", kind: "setting",
      });
      expect(result.parameters.find(p => p.name === "skipSync")).toMatchObject({
        valueType: "boolean",
      });
      expect(result.parameters.find(p => p.name === "maxRetries")).toMatchObject({
        valueType: "number",
      });
    });

    it("extracts nested object metadata (type, default, description, required)", () => {
      const files = makeFiles({
        "src/client.js": `
          MyClient.configuration = {
            practiceId: { type: String, required: true },
            importWhitespace: { type: Boolean, default: false, description: 'Enable whitespace import' },
            maxConnections: { type: Number, default: 10, required: false },
          };
        `,
      });
      const result = scanForSettings(files, "repo");
      expect(result.parameters).toHaveLength(3);

      const practiceId = result.parameters.find(p => p.name === "practiceId");
      expect(practiceId).toMatchObject({
        valueType: "string", required: true,
      });

      const importWs = result.parameters.find(p => p.name === "importWhitespace");
      expect(importWs).toMatchObject({
        valueType: "boolean", defaultValue: false, description: "Enable whitespace import",
      });

      const maxConn = result.parameters.find(p => p.name === "maxConnections");
      expect(maxConn).toMatchObject({
        valueType: "number", defaultValue: 10, required: false,
      });
    });

    it("detects variable declaration form", () => {
      const files = makeFiles({
        "src/config.ts": `
          export const configuration = {
            practiceId: { type: String, required: true },
            showFrozenSlots: { type: Boolean, default: true },
          };
        `,
      });
      const result = scanForSettings(files, "repo");
      expect(result.parameters).toHaveLength(2);
      expect(result.parameters.find(p => p.name === "practiceId")).toBeDefined();
      expect(result.parameters.find(p => p.name === "showFrozenSlots")).toMatchObject({
        defaultValue: true,
      });
    });

    it("classifies credential properties by name", () => {
      const files = makeFiles({
        "src/client.js": `
          Client.configuration = {
            password: String,
            apiKey: String,
            secretToken: { type: String, required: true },
            normalSetting: Boolean,
          };
        `,
      });
      const result = scanForSettings(files, "repo");
      expect(result.parameters.find(p => p.name === "password")?.kind).toBe("credential");
      expect(result.parameters.find(p => p.name === "apiKey")?.kind).toBe("credential");
      expect(result.parameters.find(p => p.name === "secretToken")?.kind).toBe("credential");
      expect(result.parameters.find(p => p.name === "normalSetting")?.kind).toBe("setting");
    });

    it("respects custom configDefinitionNames option", () => {
      const files = makeFiles({
        "src/client.js": `
          Client.myConfig = { host: String };
          Client.configuration = { port: Number };
        `,
      });
      const result = scanForSettings(files, "repo", {
        configDefinitionNames: ["myConfig"],
      });
      expect(result.parameters.find(p => p.name === "host")).toBeDefined();
      expect(result.parameters.find(p => p.name === "port")).toBeUndefined();
    });

    it("does not match arbitrary variable names against default", () => {
      const files = makeFiles({
        "src/app.ts": `
          const otherName = { username: String };
        `,
      });
      const result = scanForSettings(files, "repo");
      expect(result.parameters.find(p => p.name === "username")).toBeUndefined();
    });

    it("excludes test files", () => {
      const files = makeFiles({
        "src/client.test.ts": `
          Client.configuration = { host: String };
        `,
      });
      const result = scanForSettings(files, "repo");
      expect(result.parameters).toHaveLength(0);
    });

    it("merges definition with runtime access", () => {
      const files = makeFiles({
        "src/config.ts": `
          Client.configuration = {
            practiceId: { type: String, required: true },
          };
        `,
        "src/service.ts": `
          const x = credentials.practiceId;
        `,
      });
      const result = scanForSettings(files, "repo", {
        configObjectNames: ["credentials"],
      });
      // Should be merged into one parameter with two locations
      const params = result.parameters.filter(p => p.name === "practiceId");
      expect(params).toHaveLength(1);
      expect(params[0]!.locations).toHaveLength(2);
      expect(params[0]!.valueType).toBe("string"); // from the definition
    });

    it("handles Array and Object types as unknown", () => {
      const files = makeFiles({
        "src/client.js": `
          Client.configuration = {
            tags: Array,
            metadata: { type: Object, default: {} },
          };
        `,
      });
      const result = scanForSettings(files, "repo");
      expect(result.parameters.find(p => p.name === "tags")?.valueType).toBe("unknown");
      expect(result.parameters.find(p => p.name === "metadata")?.valueType).toBe("unknown");
    });
  });
});
