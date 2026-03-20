/**
 * Tests for system-wide service catalog builder.
 */

import { describe, it, expect } from "vitest";
import { InMemoryKVStore } from "@mma/storage";
import type { RepoConfig, ServiceCatalogEntry } from "@mma/core";
import { buildSystemCatalog } from "./cross-repo-catalog.js";
import type { CrossRepoGraph, ServiceCorrelationResult, ServiceLink } from "./types.js";

const makeRepo = (name: string): RepoConfig => ({
  name,
  url: `https://github.com/org/${name}`,
  branch: "main",
  localPath: `/repos/${name}`,
});

function makeGraph(): CrossRepoGraph {
  return {
    edges: [],
    repoPairs: new Set(),
    downstreamMap: new Map(),
    upstreamMap: new Map(),
  };
}

function makeCatalogEntry(name: string): ServiceCatalogEntry {
  return {
    name,
    rootPath: name,
    purpose: `${name} service`,
    dependencies: [],
    apiSurface: [],
    errorHandlingSummary: "Basic error handling",
  };
}

function makeServiceLink(endpoint: string, producers: string[], consumers: string[]): ServiceLink {
  return {
    endpoint,
    producers: new Map(producers.map((r) => [r, []])),
    consumers: new Map(consumers.map((r) => [r, []])),
    linkedRepos: new Set([...producers, ...consumers]),
  };
}

function makeCorrelation(links: ServiceLink[] = []): ServiceCorrelationResult {
  return { links, linchpins: [], orphanedServices: [] };
}

describe("buildSystemCatalog", () => {
  it("merges catalogs from multiple repos", async () => {
    const kv = new InMemoryKVStore();
    await kv.set("catalog:repo-a", JSON.stringify([makeCatalogEntry("auth-service")]));
    await kv.set("catalog:repo-b", JSON.stringify([makeCatalogEntry("user-service")]));
    const repos = [makeRepo("repo-a"), makeRepo("repo-b")];

    const result = await buildSystemCatalog(kv, repos, makeGraph(), makeCorrelation());

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.entry.name).sort()).toEqual(["auth-service", "user-service"]);
    expect(result.entries[0]!.repo).toBeDefined();
  });

  it("attaches consumer/producer info from service links", async () => {
    const kv = new InMemoryKVStore();
    await kv.set("catalog:repo-a", JSON.stringify([makeCatalogEntry("data-api")]));
    const repos = [makeRepo("repo-a"), makeRepo("repo-b")];

    const correlation = makeCorrelation([
      makeServiceLink("data-api", ["repo-a"], ["repo-b"]),
    ]);

    const result = await buildSystemCatalog(kv, repos, makeGraph(), correlation);

    const dataApi = result.entries.find((e) => e.entry.name === "data-api");
    expect(dataApi).toBeDefined();
    expect(dataApi!.producers).toContain("repo-a");
    expect(dataApi!.consumers).toContain("repo-b");
  });

  it("flags undocumented consumers", async () => {
    const kv = new InMemoryKVStore();
    // No catalog entries at all — neither producer nor consumer documents it
    const repos = [makeRepo("repo-a"), makeRepo("repo-b")];

    const correlation = makeCorrelation([
      makeServiceLink("mystery-api", ["repo-a"], ["repo-b"]),
    ]);

    const result = await buildSystemCatalog(kv, repos, makeGraph(), correlation);

    const warnings = result.sarifResults.filter(
      (r) => r.ruleId === "cross-repo/undocumented-consumer",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message.text).toContain("repo-b");
    expect(warnings[0]!.message.text).toContain("mystery-api");
  });

  it("does not flag consumers when producer documents the service", async () => {
    const kv = new InMemoryKVStore();
    // Producer documents the service
    await kv.set("catalog:repo-a", JSON.stringify([makeCatalogEntry("data-api")]));
    const repos = [makeRepo("repo-a"), makeRepo("repo-b")];

    const correlation = makeCorrelation([
      makeServiceLink("data-api", ["repo-a"], ["repo-b"]),
    ]);

    const result = await buildSystemCatalog(kv, repos, makeGraph(), correlation);

    const warnings = result.sarifResults.filter(
      (r) => r.ruleId === "cross-repo/undocumented-consumer",
    );
    expect(warnings).toHaveLength(0);
  });

  it("returns empty for repos with no catalogs", async () => {
    const kv = new InMemoryKVStore();
    const repos = [makeRepo("repo-a"), makeRepo("repo-b")];

    const result = await buildSystemCatalog(kv, repos, makeGraph(), makeCorrelation());

    expect(result.entries).toHaveLength(0);
    expect(result.sarifResults).toHaveLength(0);
  });
});
