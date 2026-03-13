import { describe, it, expect } from "vitest";
import { buildServiceCatalog } from "./catalog.js";
import type { InferredService, Summary, LogTemplateIndex } from "@mma/core";

function service(
  name: string,
  rootPath: string,
  deps: string[] = [],
  entryPoints: string[] = [],
): InferredService {
  return { name, rootPath, entryPoints, dependencies: deps, confidence: 0.9 };
}

const emptyLogIndex: LogTemplateIndex = { repo: "test-repo", templates: [] };

describe("buildServiceCatalog", () => {
  it("builds catalog entry for each service", () => {
    const services = [
      service("api", "packages/api"),
      service("web", "packages/web"),
    ];

    const catalog = buildServiceCatalog(services, new Map(), emptyLogIndex);
    expect(catalog).toHaveLength(2);
    const names = catalog.map((e) => e.name);
    expect(names).toContain("api");
    expect(names).toContain("web");
  });

  it("includes dependencies from service", () => {
    const services = [
      service("api", "packages/api", ["packages/db/src/client.ts"]),
    ];

    const catalog = buildServiceCatalog(services, new Map(), emptyLogIndex);
    expect(catalog[0]!.dependencies).toContain("packages/db/src/client.ts");
  });

  it("uses method summary count for purpose when no tier-4 summary", () => {
    const services = [service("api", "packages/api")];
    const summaries = new Map<string, Summary>([
      [
        "packages/api/src/handler.ts#getUser",
        { entityId: "packages/api/src/handler.ts#getUser", tier: 2, description: "Gets user", confidence: 0.85 },
      ],
      [
        "packages/api/src/handler.ts#saveUser",
        { entityId: "packages/api/src/handler.ts#saveUser", tier: 2, description: "Saves user", confidence: 0.85 },
      ],
    ]);

    const catalog = buildServiceCatalog(services, summaries, emptyLogIndex);
    expect(catalog[0]!.purpose).toContain("2 documented methods");
  });

  it("uses tier-4 summary for purpose when available", () => {
    const services = [service("api", "packages/api")];
    const summaries = new Map<string, Summary>([
      [
        "packages/api",
        { entityId: "packages/api", tier: 4, description: "REST API for user management", confidence: 0.9 },
      ],
    ]);

    const catalog = buildServiceCatalog(services, summaries, emptyLogIndex);
    expect(catalog[0]!.purpose).toBe("REST API for user management");
  });

  it("reports no error logging when no log templates match", () => {
    const services = [service("api", "packages/api")];
    const catalog = buildServiceCatalog(services, new Map(), emptyLogIndex);
    expect(catalog[0]!.errorHandlingSummary).toBe("No error logging detected");
  });

  it("reports error/warn template counts", () => {
    const services = [service("api", "packages/api")];
    const logIndex: LogTemplateIndex = {
      repo: "test-repo",
      templates: [
        {
          id: "t1",
          template: "query failed",
          severity: "error",
          locations: [{ repo: "test-repo", module: "packages/api/src/db.ts" }],
          frequency: 5,
        },
        {
          id: "t2",
          template: "slow response",
          severity: "warn",
          locations: [{ repo: "test-repo", module: "packages/api/src/handler.ts" }],
          frequency: 3,
        },
        {
          id: "t3",
          template: "request received",
          severity: "info",
          locations: [{ repo: "test-repo", module: "packages/api/src/handler.ts" }],
          frequency: 100,
        },
      ],
    };

    const catalog = buildServiceCatalog(services, new Map(), logIndex);
    expect(catalog[0]!.errorHandlingSummary).toBe("1 error templates, 1 warning templates");
  });

  it("infers API surface from entry points", () => {
    const services = [service("api", "packages/api", [], ["dist/index.js"])];
    const catalog = buildServiceCatalog(services, new Map(), emptyLogIndex);
    expect(catalog[0]!.apiSurface).toHaveLength(1);
    expect(catalog[0]!.apiSurface[0]!.path).toBe("dist/index.js");
  });

  it("infers API endpoints from summary names starting with HTTP verbs", () => {
    const services = [service("api", "packages/api")];
    const summaries = new Map<string, Summary>([
      [
        "packages/api/src/routes.ts#getUsers",
        { entityId: "packages/api/src/routes.ts#getUsers", tier: 2, description: "Gets all users", confidence: 0.85 },
      ],
      [
        "packages/api/src/routes.ts#postUser",
        { entityId: "packages/api/src/routes.ts#postUser", tier: 2, description: "Creates a user", confidence: 0.85 },
      ],
    ]);

    const catalog = buildServiceCatalog(services, summaries, emptyLogIndex);
    const methods = catalog[0]!.apiSurface.map((e) => e.method);
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
  });

  it("falls back to rootPath description when no summaries", () => {
    const services = [service("api", "packages/api")];
    const catalog = buildServiceCatalog(services, new Map(), emptyLogIndex);
    expect(catalog[0]!.purpose).toBe("Service at packages/api");
  });
});
