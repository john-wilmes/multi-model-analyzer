/**
 * Tests for runCorrelation() orchestrator.
 */

import { describe, it, expect } from "vitest";
import { InMemoryKVStore, InMemoryGraphStore } from "@mma/storage";
import type { RepoConfig } from "@mma/core";
import { runCorrelation } from "./run-correlation.js";
import type { CorrelationOptions } from "./types.js";

const makeRepo = (name: string, localPath = `/repos/${name}`): RepoConfig => ({
  name,
  url: `https://github.com/org/${name}`,
  branch: "main",
  localPath,
});

const emptyOptions = (repos: readonly RepoConfig[]): CorrelationOptions => ({
  repos,
  packageRoots: new Map(),
  mirrorDir: "/mirrors",
});

describe("runCorrelation", () => {
  it("returns zero-count result for empty repos", async () => {
    const kv = new InMemoryKVStore();
    const gs = new InMemoryGraphStore();
    const result = await runCorrelation(kv, gs, emptyOptions([]));

    expect(result.counts.crossRepoEdges).toBe(0);
    expect(result.counts.repoPairs).toBe(0);
    expect(result.counts.linchpins).toBe(0);
    expect(result.counts.orphanedServices).toBe(0);
    expect(result.counts.sarifFindings).toBe(0);
    expect(result.sarifResults).toHaveLength(0);
  });

  it("writes correlation:graph, correlation:services, sarif:correlation to KV", async () => {
    const kv = new InMemoryKVStore();
    const gs = new InMemoryGraphStore();
    await runCorrelation(kv, gs, emptyOptions([makeRepo("repo-a")]));

    const graphRaw = await kv.get("correlation:graph");
    const servicesRaw = await kv.get("correlation:services");
    const sarifRaw = await kv.get("sarif:correlation");

    expect(typeof graphRaw).toBe("string");
    expect(typeof servicesRaw).toBe("string");
    expect(typeof sarifRaw).toBe("string");

    // Should be valid JSON with expected shapes
    const graph = JSON.parse(graphRaw!) as { edges: unknown[]; repoPairs: string[] };
    expect(Array.isArray(graph.edges)).toBe(true);
    expect(Array.isArray(graph.repoPairs)).toBe(true);

    const services = JSON.parse(servicesRaw!) as { links: unknown[]; linchpins: unknown[]; orphanedServices: unknown[] };
    expect(Array.isArray(services.links)).toBe(true);
    expect(Array.isArray(services.linchpins)).toBe(true);
    expect(Array.isArray(services.orphanedServices)).toBe(true);

    const sarif = JSON.parse(sarifRaw!) as unknown[];
    expect(Array.isArray(sarif)).toBe(true);
  });

  it("returns full CorrelationResult with valid structure", async () => {
    const kv = new InMemoryKVStore();
    const gs = new InMemoryGraphStore();
    // Add a cross-repo import edge so graph is non-trivial
    await gs.addEdges([
      {
        source: "repo-a/src/index.ts",
        target: "@org/repo-b",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
    ]);

    const repos = [makeRepo("repo-a"), makeRepo("repo-b")];
    const packageRoots = new Map([["@org/repo-b", "repo-b"]]);
    const result = await runCorrelation(kv, gs, {
      repos,
      packageRoots,
      mirrorDir: "/mirrors",
    });

    expect(result.crossRepoGraph).toMatchObject({
      edges: expect.any(Array) as unknown,
      repoPairs: expect.any(Set) as unknown,
      downstreamMap: expect.any(Map) as unknown,
      upstreamMap: expect.any(Map) as unknown,
    });
    expect(result.serviceCorrelation).toMatchObject({
      links: expect.any(Array) as unknown,
      linchpins: expect.any(Array) as unknown,
      orphanedServices: expect.any(Array) as unknown,
    });
    expect(result.sarifResults).toBeInstanceOf(Array);
    expect(result.counts).toMatchObject({
      crossRepoEdges: expect.any(Number) as unknown,
      repoPairs: expect.any(Number) as unknown,
      linchpins: expect.any(Number) as unknown,
      orphanedServices: expect.any(Number) as unknown,
      sarifFindings: expect.any(Number) as unknown,
    });
  });

  it("aggregates SARIF results from all 3 detectors", async () => {
    const kv = new InMemoryKVStore();
    const gs = new InMemoryGraphStore();

    // Add service-call edges for orphaned service detection
    await gs.addEdges([
      {
        source: "/repos/repo-a/src/pub.ts",
        target: "unread-queue",
        kind: "service-call",
        metadata: { role: "producer", repo: "repo-a" },
      },
    ]);

    const result = await runCorrelation(kv, gs, emptyOptions([makeRepo("repo-a")]));

    // sarifResults count should equal sum of all detectors
    expect(result.counts.sarifFindings).toBe(result.sarifResults.length);

    // sarif:correlation KV should match
    const sarifRaw = await kv.get("sarif:correlation");
    const stored = JSON.parse(sarifRaw!) as unknown[];
    expect(stored).toHaveLength(result.sarifResults.length);
  });
});
