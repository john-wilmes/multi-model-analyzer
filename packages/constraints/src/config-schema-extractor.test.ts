import { describe, it, expect, beforeAll } from "vitest";
import { extractConfigSchemas } from "./config-schema-extractor.js";
import { initTreeSitter } from "@mma/parsing";
import type { ConfigField } from "./types.js";

function field(fields: readonly ConfigField[], name: string): ConfigField | undefined {
  return fields.find((f) => f.name === name);
}

describe("extractConfigSchemas", () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 15_000);

  it("returns empty result for empty input", async () => {
    const result = await extractConfigSchemas([]);
    expect(result.schemas).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips files with no configuration export", async () => {
    const result = await extractConfigSchemas([
      { path: "clients/foo/context/configuration.ts", content: "export const something = {};" },
    ]);
    expect(result.schemas).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("extracts bare type constructors", async () => {
    const result = await extractConfigSchemas([
      {
        path: "clients/mytype/context/configuration.ts",
        content: `export const clientConfiguration = {
          username: String,
          port: Number,
          enabled: Boolean,
        };`,
      },
    ]);
    expect(result.schemas).toHaveLength(1);
    const schema = result.schemas[0]!;
    expect(schema.integratorType).toBe("mytype");
    expect(schema.fields).toHaveLength(3);

    const username = field(schema.fields, "username")!;
    expect(username.inferredType).toBe("string");
    expect(username.hasDefault).toBe(false);
    expect(username.required).toBeUndefined();

    const port = field(schema.fields, "port")!;
    expect(port.inferredType).toBe("number");

    const enabled = field(schema.fields, "enabled")!;
    expect(enabled.inferredType).toBe("boolean");
  });

  it("extracts descriptor objects with type, required, default, description", async () => {
    const result = await extractConfigSchemas([
      {
        path: "clients/ecw/context/configuration.ts",
        content: `export const clientConfiguration = {
          syncRange: {
            type: Number,
            required: false,
            default: 4,
            description: 'Days per query batch',
          },
          url: {
            type: String,
            required: true,
            description: 'The root domain',
          },
          useProxy: {
            type: Boolean,
            required: false,
            default: false,
          },
          items: {
            type: Array,
            required: false,
            default: [],
          },
          options: {
            type: Object,
            required: false,
            default: {},
          },
        };`,
      },
    ]);
    const schema = result.schemas[0]!;
    expect(schema.integratorType).toBe("ecw");

    const syncRange = field(schema.fields, "syncRange")!;
    expect(syncRange.inferredType).toBe("number");
    expect(syncRange.hasDefault).toBe(true);
    expect(syncRange.defaultValue).toBe(4);
    expect(syncRange.required).toBe(false);
    expect(syncRange.description).toBe("Days per query batch");

    const url = field(schema.fields, "url")!;
    expect(url.inferredType).toBe("string");
    expect(url.hasDefault).toBe(false);
    expect(url.required).toBe(true);

    const useProxy = field(schema.fields, "useProxy")!;
    expect(useProxy.inferredType).toBe("boolean");
    expect(useProxy.hasDefault).toBe(true);
    expect(useProxy.defaultValue).toBe(false);

    const items = field(schema.fields, "items")!;
    expect(items.inferredType).toBe("array");
    expect(items.hasDefault).toBe(true);
    expect(items.defaultValue).toEqual([]);

    const options = field(schema.fields, "options")!;
    expect(options.inferredType).toBe("object");
    expect(options.hasDefault).toBe(true);
    expect(options.defaultValue).toEqual({});
  });

  it("extracts extended metadata fields", async () => {
    const result = await extractConfigSchemas([
      {
        path: "clients/cerner/context/configuration.ts",
        content: `export const configuration = {
          authUrl: {
            type: String,
            required: true,
            description: 'Auth endpoint',
            category: 'Connection',
            categoryKey: 'login',
            friendlyName: 'Authorization URL',
            visible: true,
            editable: true,
            isSensitive: false,
          },
        };`,
      },
    ]);
    const schema = result.schemas[0]!;
    const authUrl = field(schema.fields, "authUrl")!;
    expect(authUrl.metadata).toBeDefined();
    expect(authUrl.metadata!.category).toBe("Connection");
    expect(authUrl.metadata!.visible).toBe(true);
    expect(authUrl.metadata!.isSensitive).toBe(false);
  });

  it("handles mixed bare types and descriptors", async () => {
    const result = await extractConfigSchemas([
      {
        path: "clients/advancedmd/context/configuration.ts",
        content: `export const clientConfiguration = {
          username: String,
          password: String,
          useColumnsAsProviders: {
            type: Boolean,
            default: false,
            required: false,
          },
        };`,
      },
    ]);
    const schema = result.schemas[0]!;
    expect(schema.fields).toHaveLength(3);
    expect(field(schema.fields, "username")!.inferredType).toBe("string");
    expect(field(schema.fields, "useColumnsAsProviders")!.inferredType).toBe("boolean");
  });

  it("detects vendor spread and records extendsType", async () => {
    const result = await extractConfigSchemas([
      {
        path: "clients/epic/vendors/mi7/context/configuration.ts",
        content: `import { configuration as epicConfig } from '../../../context/configuration';
        export const configuration = {
          ...epicConfig,
          testing: {
            type: Boolean,
            required: false,
            default: true,
          },
        };`,
      },
    ]);
    const schema = result.schemas[0]!;
    expect(schema.integratorType).toBe("mi7");
    expect(schema.extendsType).toBe("epicConfig");
    expect(field(schema.fields, "testing")!.defaultValue).toBe(true);
  });

  it("recognizes both configuration and clientConfiguration export names", async () => {
    const files = [
      {
        path: "clients/typeA/context/configuration.ts",
        content: `export const configuration = { field1: String };`,
      },
      {
        path: "clients/typeB/context/configuration.ts",
        content: `export const clientConfiguration = { field2: Number };`,
      },
    ];
    const result = await extractConfigSchemas(files);
    expect(result.schemas).toHaveLength(2);
    expect(result.schemas.map((s) => s.integratorType).sort()).toEqual(["typeA", "typeB"]);
  });

  it("handles default: undefined as hasDefault false", async () => {
    const result = await extractConfigSchemas([
      {
        path: "clients/test/context/configuration.ts",
        content: `export const configuration = {
          username: {
            type: String,
            default: undefined,
          },
        };`,
      },
    ]);
    const f = field(result.schemas[0]!.fields, "username")!;
    expect(f.hasDefault).toBe(false);
  });

  it("marks complex default values as [complex]", async () => {
    const result = await extractConfigSchemas([
      {
        path: "clients/test/context/configuration.ts",
        content: `export const configuration = {
          mapping: {
            type: Object,
            default: { a: 1, b: 2 },
          },
        };`,
      },
    ]);
    const f = field(result.schemas[0]!.fields, "mapping")!;
    expect(f.hasDefault).toBe(true);
    expect(f.defaultValue).toBe("[complex]");
  });

  it("extracts from satisfies-annotated config", async () => {
    const result = await extractConfigSchemas([
      {
        path: "clients/ecw10e/context/configuration.ts",
        content: `export const clientConfiguration = {
          username: String,
          syncRange: {
            type: Number,
            required: false,
            default: 4,
          },
        } satisfies Record<string, any>;`,
      },
    ]);
    const schema = result.schemas[0]!;
    expect(schema.fields).toHaveLength(2);
    expect(field(schema.fields, "username")!.inferredType).toBe("string");
    expect(field(schema.fields, "syncRange")!.defaultValue).toBe(4);
  });
});
