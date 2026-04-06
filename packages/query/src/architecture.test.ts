/**
 * Tests for cross-repo architecture query handler.
 */

import { describe, it, expect } from "vitest";
import { executeArchitectureQuery } from "./architecture.js";
import { InMemoryGraphStore, InMemoryKVStore } from "@mma/storage";
import type { GraphEdge } from "@mma/core";

function makeEdge(
  source: string,
  target: string,
  kind: GraphEdge["kind"],
  repo: string,
  extra?: Record<string, unknown>,
): GraphEdge {
  return { source, target, kind, repo, metadata: { repo, ...extra } };
}

describe("executeArchitectureQuery", () => {
  it("returns empty result for empty stores", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    const result = await executeArchitectureQuery(graphStore, kvStore);
    expect(result.repos).toHaveLength(0);
    expect(result.crossRepoEdges).toHaveLength(0);
    expect(result.serviceTopology).toHaveLength(0);
  });

  it("infers frontend role from React imports + HTTP calls", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/app.tsx", "react", "imports", "dashboard"),
      makeEdge("src/api.ts", "external-api", "service-call", "dashboard", {
        protocol: "http",
        role: "client",
      }),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    const dashRepo = result.repos.find((r) => r.name === "dashboard");
    expect(dashRepo).toBeDefined();
    expect(dashRepo!.role).toBe("frontend");
  });

  it("infers backend-service role from NestJS imports", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/main.ts", "@nestjs/core", "imports", "api-service"),
      makeEdge("src/main.ts", "@nestjs/common", "imports", "api-service"),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    const apiRepo = result.repos.find((r) => r.name === "api-service");
    expect(apiRepo).toBeDefined();
    expect(apiRepo!.role).toBe("backend-service");
  });

  it("infers backend-service role from queue producers", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/sender.ts", "email-queue", "service-call", "notifier", {
        protocol: "queue",
        role: "producer",
      }),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    const repo = result.repos.find((r) => r.name === "notifier");
    expect(repo!.role).toBe("backend-service");
  });

  it("infers shared-library role when imported by others and name contains lib", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      // Another repo imports a package matching this repo's name
      makeEdge("src/app.ts", "@novu/shared-lib", "imports", "api"),
      // The lib itself has some internal imports
      makeEdge("src/index.ts", "./utils", "imports", "shared-lib"),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    const libRepo = result.repos.find((r) => r.name === "shared-lib");
    expect(libRepo).toBeDefined();
    expect(libRepo!.role).toBe("shared-library");
  });

  it("counts cross-repo imports correctly", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/a.ts", "@novu/shared", "imports", "api"),
      makeEdge("src/b.ts", "@novu/shared", "imports", "api"),
      makeEdge("src/c.ts", "@novu/dal", "imports", "api"),
      makeEdge("src/d.ts", "./local", "imports", "api"),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    const apiRepo = result.repos.find((r) => r.name === "api");
    expect(apiRepo!.crossRepoImports).toBe(3);
    expect(apiRepo!.importCount).toBe(4);

    // Cross-repo edges should be sorted by count descending
    expect(result.crossRepoEdges[0]!.targetPackage).toBe("@novu/shared");
    expect(result.crossRepoEdges[0]!.count).toBe(2);
    expect(result.crossRepoEdges[1]!.targetPackage).toBe("@novu/dal");
    expect(result.crossRepoEdges[1]!.count).toBe(1);
  });

  it("normalizes scoped package paths to base package", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/a.ts", "@novu/shared/utils", "imports", "api"),
      makeEdge("src/b.ts", "@novu/shared/types", "imports", "api"),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    // Both should normalize to @novu/shared
    expect(result.crossRepoEdges).toHaveLength(1);
    expect(result.crossRepoEdges[0]!.targetPackage).toBe("@novu/shared");
    expect(result.crossRepoEdges[0]!.count).toBe(2);
  });

  it("builds service topology links from service-call edges", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/sender.ts", "email-queue", "service-call", "worker", {
        protocol: "queue",
        role: "producer",
        detail: "this.queueService.add('send')",
      }),
      makeEdge("src/gateway.ts", "ws-events", "service-call", "api", {
        protocol: "websocket",
        role: "server",
        detail: "@WebSocketGateway()",
      }),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    expect(result.serviceTopology).toHaveLength(2);

    const queueLink = result.serviceTopology.find(
      (l) => l.protocol === "queue",
    );
    expect(queueLink!.sourceRepo).toBe("worker");
    expect(queueLink!.target).toBe("email-queue");
    expect(queueLink!.role).toBe("producer");

    const wsLink = result.serviceTopology.find(
      (l) => l.protocol === "websocket",
    );
    expect(wsLink!.sourceRepo).toBe("api");
    expect(wsLink!.role).toBe("server");
  });

  it("filters by repo when repoFilter is specified", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/a.ts", "react", "imports", "frontend"),
      makeEdge("src/b.ts", "@nestjs/core", "imports", "backend"),
      makeEdge("src/c.ts", "email-queue", "service-call", "backend", {
        protocol: "queue",
        role: "producer",
      }),
    ]);

    const filtered = await executeArchitectureQuery(
      graphStore,
      kvStore,
      "backend",
    );
    // Only backend repo in output
    expect(filtered.repos).toHaveLength(1);
    expect(filtered.repos[0]!.name).toBe("backend");
    // Only backend service topology
    expect(filtered.serviceTopology.every((l) => l.sourceRepo === "backend")).toBe(true);
  });

  it("description includes repo count and edge counts", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/a.ts", "@novu/shared", "imports", "api"),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    expect(result.description).toContain("1 repos");
    expect(result.description).toContain("cross-repo import edges");
  });

  it("infers backend-service from express import", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/server.ts", "express", "imports", "api-gateway"),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    expect(result.repos.find((r) => r.name === "api-gateway")!.role).toBe("backend-service");
  });

  it("infers backend-service from fastify import", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/app.ts", "fastify", "imports", "rest-api"),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    expect(result.repos.find((r) => r.name === "rest-api")!.role).toBe("backend-service");
  });

  it("infers backend-service from 3+ Node.js builtin imports", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/main.ts", "node:fs", "imports", "cli-tool"),
      makeEdge("src/main.ts", "node:path", "imports", "cli-tool"),
      makeEdge("src/main.ts", "node:http", "imports", "cli-tool"),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    expect(result.repos.find((r) => r.name === "cli-tool")!.role).toBe("backend-service");
  });

  it("infers shared-library from name containing 'shared' or 'utils'", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/index.ts", "./helpers", "imports", "shared-types"),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    expect(result.repos.find((r) => r.name === "shared-types")!.role).toBe("shared-library");
  });

  it("infers shared-library from high fan-in (3+ importers)", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    // Register @acme/config as an indexed package
    await kvStore.set("_packageRoots", JSON.stringify([["@acme/config", "packages/config"]]));
    await graphStore.addEdges([
      // config repo's own imports
      makeEdge("src/index.ts", "./defaults", "imports", "config"),
      // 3 other repos import @acme/config
      makeEdge("src/a.ts", "@acme/config", "imports", "api"),
      makeEdge("src/b.ts", "@acme/config", "imports", "worker"),
      makeEdge("src/c.ts", "@acme/config", "imports", "dashboard"),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    expect(result.repos.find((r) => r.name === "config")!.role).toBe("shared-library");
  });

  it("infers frontend from React imports with no service calls", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/App.tsx", "react", "imports", "ui-app"),
      makeEdge("src/App.tsx", "react-dom", "imports", "ui-app"),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    expect(result.repos.find((r) => r.name === "ui-app")!.role).toBe("frontend");
  });

  it("does not infer frontend for React repo with library-style name", async () => {
    const graphStore = new InMemoryGraphStore();
    const kvStore = new InMemoryKVStore();
    await graphStore.addEdges([
      makeEdge("src/Button.tsx", "react", "imports", "ui-utils"),
    ]);
    const result = await executeArchitectureQuery(graphStore, kvStore);
    // "utils" in name → shared-library takes priority
    expect(result.repos.find((r) => r.name === "ui-utils")!.role).toBe("shared-library");
  });
});
