/**
 * Tests for buildServiceCorrelation().
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryGraphStore } from "@mma/storage";
import type { RepoConfig } from "@mma/core";
import type { CrossRepoGraph } from "./types.js";
import { buildServiceCorrelation } from "./service-correlation.js";

const makeRepo = (name: string, localPath = `/repos/${name}`): RepoConfig => ({
  name,
  url: `https://github.com/org/${name}`,
  branch: "main",
  localPath,
});

describe("buildServiceCorrelation", () => {
  let graphStore: InMemoryGraphStore;

  beforeEach(() => {
    graphStore = new InMemoryGraphStore();
  });

  it("returns empty result for empty graph", async () => {
    const result = await buildServiceCorrelation(graphStore, [makeRepo("repo-a")]);
    expect(result.links).toHaveLength(0);
    expect(result.linchpins).toHaveLength(0);
    expect(result.orphanedServices).toHaveLength(0);
  });

  it("discovers basic service links across 2 repos", async () => {
    await graphStore.addEdges([
      {
        source: "/repos/repo-a/src/publisher.ts",
        target: "user-events-queue",
        kind: "service-call",
        metadata: { role: "producer", repo: "repo-a" },
      },
      {
        source: "/repos/repo-b/src/consumer.ts",
        target: "user-events-queue",
        kind: "service-call",
        metadata: { role: "consumer", repo: "repo-b" },
      },
    ]);

    const repos = [makeRepo("repo-a"), makeRepo("repo-b")];
    const result = await buildServiceCorrelation(graphStore, repos);

    expect(result.links).toHaveLength(1);
    const link = result.links[0]!;
    expect(link.endpoint).toBe("user-events-queue");
    expect(link.producers.has("repo-a")).toBe(true);
    expect(link.consumers.has("repo-b")).toBe(true);
    expect(link.linkedRepos.has("repo-a")).toBe(true);
    expect(link.linkedRepos.has("repo-b")).toBe(true);
  });

  it("detects linchpin services with high cross-repo coupling", async () => {
    await graphStore.addEdges([
      // repo-a produces
      {
        source: "/repos/repo-a/src/pub.ts",
        target: "/api/orders",
        kind: "service-call",
        metadata: { role: "producer", repo: "repo-a" },
      },
      // repo-b and repo-c consume
      {
        source: "/repos/repo-b/src/consumer.ts",
        target: "/api/orders",
        kind: "service-call",
        metadata: { role: "consumer", repo: "repo-b" },
      },
      {
        source: "/repos/repo-c/src/consumer.ts",
        target: "/api/orders",
        kind: "service-call",
        metadata: { role: "consumer", repo: "repo-c" },
      },
    ]);

    const repos = [makeRepo("repo-a"), makeRepo("repo-b"), makeRepo("repo-c")];
    const result = await buildServiceCorrelation(graphStore, repos);

    expect(result.linchpins).toHaveLength(1);
    const lp = result.linchpins[0]!;
    expect(lp.endpoint).toBe("/api/orders");
    expect(lp.producerCount).toBe(1);
    expect(lp.consumerCount).toBe(2);
    expect(lp.linkedRepoCount).toBe(3);
    // Score = (1 + 2) * 3 = 9
    expect(lp.criticalityScore).toBe(9);
  });

  it("sorts linchpins by criticalityScore descending", async () => {
    await graphStore.addEdges([
      // low-score endpoint: 1 producer + 1 consumer across 2 repos = (1+1)*2 = 4
      {
        source: "/repos/repo-a/src/pub.ts",
        target: "low-endpoint",
        kind: "service-call",
        metadata: { role: "producer", repo: "repo-a" },
      },
      {
        source: "/repos/repo-b/src/con.ts",
        target: "low-endpoint",
        kind: "service-call",
        metadata: { role: "consumer", repo: "repo-b" },
      },
      // high-score endpoint: 2 producers + 2 consumers across 4 repos = (2+2)*4 = 16
      {
        source: "/repos/repo-a/src/pub2.ts",
        target: "high-endpoint",
        kind: "service-call",
        metadata: { role: "producer", repo: "repo-a" },
      },
      {
        source: "/repos/repo-b/src/pub2.ts",
        target: "high-endpoint",
        kind: "service-call",
        metadata: { role: "producer", repo: "repo-b" },
      },
      {
        source: "/repos/repo-c/src/con.ts",
        target: "high-endpoint",
        kind: "service-call",
        metadata: { role: "consumer", repo: "repo-c" },
      },
      {
        source: "/repos/repo-d/src/con.ts",
        target: "high-endpoint",
        kind: "service-call",
        metadata: { role: "consumer", repo: "repo-d" },
      },
    ]);

    const repos = [
      makeRepo("repo-a"),
      makeRepo("repo-b"),
      makeRepo("repo-c"),
      makeRepo("repo-d"),
    ];
    const result = await buildServiceCorrelation(graphStore, repos);

    expect(result.linchpins.length).toBeGreaterThanOrEqual(2);
    expect(result.linchpins[0]!.endpoint).toBe("high-endpoint");
    expect(result.linchpins[0]!.criticalityScore).toBe(16);
    expect(result.linchpins[1]!.endpoint).toBe("low-endpoint");
    expect(result.linchpins[1]!.criticalityScore).toBe(4);
  });

  it("does NOT flag same-repo producer+consumer as orphaned", async () => {
    await graphStore.addEdges([
      {
        source: "/repos/repo-a/src/pub.ts",
        target: "internal-queue",
        kind: "service-call",
        metadata: { role: "producer", repo: "repo-a" },
      },
      // consumer in same repo as producer — healthy intra-repo service
      {
        source: "/repos/repo-a/src/con.ts",
        target: "internal-queue",
        kind: "service-call",
        metadata: { role: "consumer", repo: "repo-a" },
      },
    ]);

    const result = await buildServiceCorrelation(graphStore, [makeRepo("repo-a")]);

    const orphaned = result.orphanedServices.find((o) => o.endpoint === "internal-queue");
    expect(orphaned).toBeUndefined();
  });

  it("detects orphaned service: producer with no consumers at all", async () => {
    await graphStore.addEdges([
      {
        source: "/repos/repo-a/src/pub.ts",
        target: "no-consumer-queue",
        kind: "service-call",
        metadata: { role: "producer", repo: "repo-a" },
      },
    ]);

    const result = await buildServiceCorrelation(graphStore, [makeRepo("repo-a"), makeRepo("repo-b")]);

    const orphaned = result.orphanedServices.find((o) => o.endpoint === "no-consumer-queue");
    expect(orphaned).toBeDefined();
    expect(orphaned!.hasProducers).toBe(true);
    expect(orphaned!.hasConsumers).toBe(false);
  });

  it("does not flag cross-repo service as orphaned", async () => {
    await graphStore.addEdges([
      {
        source: "/repos/repo-a/src/pub.ts",
        target: "cross-queue",
        kind: "service-call",
        metadata: { role: "producer", repo: "repo-a" },
      },
      {
        source: "/repos/repo-b/src/con.ts",
        target: "cross-queue",
        kind: "service-call",
        metadata: { role: "consumer", repo: "repo-b" },
      },
    ]);

    const repos = [makeRepo("repo-a"), makeRepo("repo-b")];
    const result = await buildServiceCorrelation(graphStore, repos);

    const orphaned = result.orphanedServices.find((o) => o.endpoint === "cross-queue");
    expect(orphaned).toBeUndefined();
  });

  it("does not flag single-repo-only services as linchpins", async () => {
    await graphStore.addEdges([
      {
        source: "/repos/repo-a/src/pub.ts",
        target: "local-queue",
        kind: "service-call",
        metadata: { role: "producer", repo: "repo-a" },
      },
      {
        source: "/repos/repo-a/src/con.ts",
        target: "local-queue",
        kind: "service-call",
        metadata: { role: "consumer", repo: "repo-a" },
      },
    ]);

    const result = await buildServiceCorrelation(graphStore, [makeRepo("repo-a")]);

    // Single repo — cannot be a linchpin (requires linkedRepos >= 2)
    expect(result.linchpins).toHaveLength(0);
  });

  it("falls back to localPath prefix matching for repo resolution", async () => {
    // No repo in metadata — resolve via edge.source prefix
    await graphStore.addEdges([
      {
        source: "/repos/repo-a/src/pub.ts",
        target: "prefix-queue",
        kind: "service-call",
        metadata: { role: "producer" },
      },
      {
        source: "/repos/repo-b/src/con.ts",
        target: "prefix-queue",
        kind: "service-call",
        metadata: { role: "consumer" },
      },
    ]);

    const repos = [makeRepo("repo-a", "/repos/repo-a"), makeRepo("repo-b", "/repos/repo-b")];
    const result = await buildServiceCorrelation(graphStore, repos);

    expect(result.links).toHaveLength(1);
    const link = result.links[0]!;
    expect(link.producers.has("repo-a")).toBe(true);
    expect(link.consumers.has("repo-b")).toBe(true);
  });

  describe("package linchpins", () => {
    const makeCrossRepoGraph = (
      edges: Array<{ packageName: string; sourceRepo: string; targetRepo: string }>,
    ): CrossRepoGraph => ({
      edges: edges.map((e) => ({
        edge: { source: "x", target: "y", kind: "imports" as const },
        sourceRepo: e.sourceRepo,
        targetRepo: e.targetRepo,
        packageName: e.packageName,
      })),
      repoPairs: new Set(),
      downstreamMap: new Map(),
      upstreamMap: new Map(),
    });

    it("returns empty when no cross-repo graph provided", async () => {
      const result = await buildServiceCorrelation(graphStore, [makeRepo("repo-a")]);
      expect(result.packageLinchpins).toHaveLength(0);
    });

    it("detects package imported by 2+ repos", async () => {
      const graph = makeCrossRepoGraph([
        { packageName: "@supabase/auth-helpers", sourceRepo: "app-a", targetRepo: "auth-helpers" },
        { packageName: "@supabase/auth-helpers", sourceRepo: "app-b", targetRepo: "auth-helpers" },
        { packageName: "@supabase/auth-helpers", sourceRepo: "app-c", targetRepo: "auth-helpers" },
      ]);

      const result = await buildServiceCorrelation(graphStore, [], graph);

      expect(result.packageLinchpins).toHaveLength(1);
      const pkg = result.packageLinchpins[0]!;
      expect(pkg.packageName).toBe("@supabase/auth-helpers");
      expect(pkg.ownerRepo).toBe("auth-helpers");
      expect(pkg.importerCount).toBe(3);
      expect(pkg.importingRepos).toEqual(["app-a", "app-b", "app-c"]);
      expect(pkg.edgeCount).toBe(3);
      expect(pkg.criticalityScore).toBe(9); // 3 * 3
    });

    it("ignores packages imported by only 1 repo", async () => {
      const graph = makeCrossRepoGraph([
        { packageName: "lodash", sourceRepo: "app-a", targetRepo: "npm" },
      ]);

      const result = await buildServiceCorrelation(graphStore, [], graph);
      expect(result.packageLinchpins).toHaveLength(0);
    });

    it("sorts by criticalityScore descending", async () => {
      const graph = makeCrossRepoGraph([
        // low: 2 importers * 2 edges = 4
        { packageName: "low-pkg", sourceRepo: "a", targetRepo: "owner" },
        { packageName: "low-pkg", sourceRepo: "b", targetRepo: "owner" },
        // high: 3 importers * 5 edges = 15
        { packageName: "high-pkg", sourceRepo: "a", targetRepo: "owner" },
        { packageName: "high-pkg", sourceRepo: "b", targetRepo: "owner" },
        { packageName: "high-pkg", sourceRepo: "c", targetRepo: "owner" },
        { packageName: "high-pkg", sourceRepo: "a", targetRepo: "owner" }, // duplicate importer, extra edge
        { packageName: "high-pkg", sourceRepo: "b", targetRepo: "owner" }, // duplicate importer, extra edge
      ]);

      const result = await buildServiceCorrelation(graphStore, [], graph);

      expect(result.packageLinchpins).toHaveLength(2);
      expect(result.packageLinchpins[0]!.packageName).toBe("high-pkg");
      expect(result.packageLinchpins[0]!.criticalityScore).toBe(15); // 3 * 5
      expect(result.packageLinchpins[1]!.packageName).toBe("low-pkg");
      expect(result.packageLinchpins[1]!.criticalityScore).toBe(4); // 2 * 2
    });

    it("counts multiple edges from same repo correctly", async () => {
      const graph = makeCrossRepoGraph([
        { packageName: "shared-types", sourceRepo: "api", targetRepo: "types-pkg" },
        { packageName: "shared-types", sourceRepo: "api", targetRepo: "types-pkg" }, // same repo, 2nd file
        { packageName: "shared-types", sourceRepo: "web", targetRepo: "types-pkg" },
      ]);

      const result = await buildServiceCorrelation(graphStore, [], graph);

      expect(result.packageLinchpins).toHaveLength(1);
      const pkg = result.packageLinchpins[0]!;
      expect(pkg.importerCount).toBe(2); // api, web (deduplicated)
      expect(pkg.edgeCount).toBe(3); // 3 total edges
      expect(pkg.criticalityScore).toBe(6); // 2 * 3
    });
  });
});
