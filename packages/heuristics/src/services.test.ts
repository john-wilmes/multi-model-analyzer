import { describe, it, expect } from "vitest";
import { inferServices, inferServicesWithMeta } from "./services.js";
import type { ServiceInferenceInput, PackageJsonInfo } from "./services.js";
import type { DependencyGraph } from "@mma/core";

function makeGraph(edges: Array<{ source: string; target: string }> = []): DependencyGraph {
  return {
    repo: "test-repo",
    edges: edges.map((e) => ({ ...e, kind: "imports" as const })),
    circularDependencies: [],
  };
}

describe("inferServices", () => {
  it("infers service from package.json with main entry", () => {
    const pkgs = new Map<string, PackageJsonInfo>([
      [
        "packages/api",
        {
          name: "@myapp/api",
          main: "dist/index.js",
          dependencies: {},
          scripts: {},
        },
      ],
    ]);

    const input: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: ["packages/api/src/index.ts"],
      packageJsons: pkgs,
      dependencyGraph: makeGraph(),
    };

    const services = inferServices(input);
    expect(services).toHaveLength(1);
    expect(services[0]!.name).toBe("@myapp/api");
    expect(services[0]!.rootPath).toBe("packages/api");
    expect(services[0]!.entryPoints).toContain("dist/index.js");
    expect(services[0]!.confidence).toBe(0.5);
  });

  it("infers service from bin entry", () => {
    const pkgs = new Map<string, PackageJsonInfo>([
      [
        "apps/cli",
        {
          name: "my-cli",
          bin: { mycli: "bin/cli.js" },
          dependencies: {},
          scripts: {},
        },
      ],
    ]);

    const input: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [],
      packageJsons: pkgs,
      dependencyGraph: makeGraph(),
    };

    const services = inferServices(input);
    expect(services[0]!.entryPoints).toContain("bin/cli.js");
    expect(services[0]!.confidence).toBe(0.9);
  });

  it("demotes main-only packages to 0.5 confidence (libraries, not services)", () => {
    const pkgs = new Map<string, PackageJsonInfo>([
      [
        "packages/utils",
        {
          name: "@myapp/utils",
          main: "dist/index.js",
          dependencies: {},
          scripts: {},
        },
      ],
      [
        "packages/api",
        {
          name: "@myapp/api",
          main: "dist/index.js",
          bin: { api: "bin/serve.js" },
          dependencies: {},
          scripts: {},
        },
      ],
    ]);

    const input: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [],
      packageJsons: pkgs,
      dependencyGraph: makeGraph(),
    };

    const services = inferServices(input);
    const utils = services.find((s) => s.name === "@myapp/utils");
    const api = services.find((s) => s.name === "@myapp/api");
    expect(utils!.confidence).toBe(0.5);
    expect(api!.confidence).toBe(0.9);
  });

  it("infers service from start script", () => {
    const pkgs = new Map<string, PackageJsonInfo>([
      [
        "services/web",
        {
          name: "web-server",
          dependencies: {},
          scripts: { start: "node dist/server.js" },
        },
      ],
    ]);

    const input: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [],
      packageJsons: pkgs,
      dependencyGraph: makeGraph(),
    };

    const services = inferServices(input);
    expect(services[0]!.entryPoints).toContain("(start script)");
  });

  it("infers service from directory patterns when no package.json", () => {
    const input: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [
        "apps/frontend/src/App.tsx",
        "apps/frontend/src/index.ts",
        "services/auth/src/index.ts",
      ],
      packageJsons: new Map(),
      dependencyGraph: makeGraph(),
    };

    const services = inferServices(input);
    const names = services.map((s) => s.name);
    expect(names).toContain("frontend");
    expect(names).toContain("auth");
    expect(services.every((s) => s.confidence === 0.6)).toBe(true);
  });

  it("deduplicates services from same root", () => {
    const input: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [
        "apps/web/src/a.ts",
        "apps/web/src/b.ts",
        "apps/web/src/c.ts",
      ],
      packageJsons: new Map(),
      dependencyGraph: makeGraph(),
    };

    const services = inferServices(input);
    expect(services).toHaveLength(1);
    expect(services[0]!.name).toBe("web");
  });

  it("finds cross-service dependencies from graph edges", () => {
    const graph = makeGraph([
      { source: "packages/api/src/handler.ts", target: "packages/db/src/client.ts" },
    ]);

    const pkgs = new Map<string, PackageJsonInfo>([
      ["packages/api", { name: "api", main: "dist/index.js", dependencies: {}, scripts: {} }],
      ["packages/db", { name: "db", main: "dist/index.js", dependencies: {}, scripts: {} }],
    ]);

    const input: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [],
      packageJsons: pkgs,
      dependencyGraph: graph,
    };

    const services = inferServices(input);
    const api = services.find((s) => s.name === "api");
    // W18: dependencies resolved to service names when target is a known service
    expect(api!.dependencies).toContain("db");
  });

  it("W17: filters packages/* dirs without entry-point files", () => {
    const input: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [
        "packages/utils/src/helpers.ts",
        "packages/types/src/index.ts",
        "packages/api-gateway/src/main.ts",
        "packages/api-gateway/src/routes.ts",
      ],
      packageJsons: new Map(),
      dependencyGraph: makeGraph(),
    };

    const services = inferServices(input);
    const names = services.map((s) => s.name);
    // api-gateway has main.ts → kept; utils/types have no entry-point → filtered
    expect(names).toContain("api-gateway");
    expect(names).not.toContain("utils");
    expect(names).not.toContain("types");
  });

  it("W17: apps/* and services/* dirs kept without entry-point check", () => {
    const input: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [
        "apps/dashboard/src/components/Chart.tsx",
        "services/notifications/src/queue.ts",
      ],
      packageJsons: new Map(),
      dependencyGraph: makeGraph(),
    };

    const services = inferServices(input);
    const names = services.map((s) => s.name);
    expect(names).toContain("dashboard");
    expect(names).toContain("notifications");
  });

  it("W18: dependencies use service names when target is unknown service", () => {
    const graph = makeGraph([
      { source: "apps/web/src/page.ts", target: "libs/shared/src/util.ts" },
    ]);

    const input: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [
        "apps/web/src/page.ts",
        "libs/shared/src/util.ts",
      ],
      packageJsons: new Map(),
      dependencyGraph: graph,
    };

    const services = inferServices(input);
    const web = services.find((s) => s.name === "web");
    // libs/shared is not a recognized service dir, so dep stays as raw path
    expect(web!.dependencies).toContain("libs/shared/src/util.ts");
  });

  it("excludes node_modules from dependencies", () => {
    const graph = makeGraph([
      { source: "packages/api/src/index.ts", target: "node_modules/express/index.js" },
    ]);

    const pkgs = new Map<string, PackageJsonInfo>([
      ["packages/api", { name: "api", main: "dist/index.js", dependencies: {}, scripts: {} }],
    ]);

    const input: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [],
      packageJsons: pkgs,
      dependencyGraph: graph,
    };

    const services = inferServices(input);
    expect(services[0]!.dependencies).toHaveLength(0);
  });
});

describe("inferServicesWithMeta", () => {
  it("meta.heuristic equals 'inferServices'", () => {
    const input: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [],
      packageJsons: new Map(),
      dependencyGraph: makeGraph(),
    };
    const result = inferServicesWithMeta(input);
    expect(result.meta.heuristic).toBe("inferServices");
  });

  it("meta.itemCount matches data.length", () => {
    const pkgs = new Map<string, PackageJsonInfo>([
      [
        "packages/svc",
        {
          name: "@myapp/svc",
          main: "dist/index.js",
          dependencies: {},
          scripts: {},
        },
      ],
    ]);
    const input: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [],
      packageJsons: pkgs,
      dependencyGraph: makeGraph(),
    };
    const result = inferServicesWithMeta(input);
    expect(result.meta.itemCount).toBe(result.data.length);
    expect(result.meta.itemCount).toBe(1);
  });

  it("confidenceStats undefined for empty input, populated when services exist", () => {
    const emptyInput: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [],
      packageJsons: new Map(),
      dependencyGraph: makeGraph(),
    };
    const emptyResult = inferServicesWithMeta(emptyInput);
    expect(emptyResult.meta.confidenceStats).toBeUndefined();

    const pkgs = new Map<string, PackageJsonInfo>([
      [
        "packages/svc",
        {
          name: "@myapp/svc",
          main: "dist/index.js",
          dependencies: {},
          scripts: {},
        },
      ],
    ]);
    const filledInput: ServiceInferenceInput = {
      repo: "test-repo",
      filePaths: [],
      packageJsons: pkgs,
      dependencyGraph: makeGraph(),
    };
    const filledResult = inferServicesWithMeta(filledInput);
    expect(filledResult.meta.confidenceStats).toBeDefined();
    expect(filledResult.meta.confidenceStats!.min).toBeGreaterThanOrEqual(0);
    expect(filledResult.meta.confidenceStats!.max).toBeLessThanOrEqual(1);
    expect(filledResult.meta.confidenceStats!.mean).toBeGreaterThanOrEqual(0);
  });
});
