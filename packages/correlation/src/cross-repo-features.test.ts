/**
 * Tests for cross-repo feature flag coordination detection.
 */

import { describe, it, expect } from "vitest";
import { InMemoryKVStore } from "@mma/storage";
import type { RepoConfig, FlagInventory } from "@mma/core";
import { detectCrossRepoFeatures } from "./cross-repo-features.js";
import type { CrossRepoGraph } from "./types.js";

const makeRepo = (name: string): RepoConfig => ({
  name,
  url: `https://github.com/org/${name}`,
  branch: "main",
  localPath: `/repos/${name}`,
});

function makeGraph(pairs: string[] = []): CrossRepoGraph {
  return {
    edges: [],
    repoPairs: new Set(pairs),
    downstreamMap: new Map(),
    upstreamMap: new Map(),
  };
}

async function setFlags(kv: InMemoryKVStore, repo: string, flagNames: string[]): Promise<void> {
  const inventory: FlagInventory = {
    repo,
    flags: flagNames.map((name) => ({
      name,
      locations: [{ repo, module: `${repo}/src/flags.ts`, fullyQualifiedName: `${repo}::${name}` }],
    })),
  };
  await kv.set(`flags:${repo}`, JSON.stringify(inventory));
}

describe("detectCrossRepoFeatures", () => {
  it("detects shared flags across repos", async () => {
    const kv = new InMemoryKVStore();
    await setFlags(kv, "repo-a", ["DARK_MODE", "BETA_UI"]);
    await setFlags(kv, "repo-b", ["DARK_MODE", "NEW_SEARCH"]);
    const repos = [makeRepo("repo-a"), makeRepo("repo-b")];

    const result = await detectCrossRepoFeatures(kv, repos, makeGraph());

    expect(result.sharedFlags).toHaveLength(1);
    expect(result.sharedFlags[0]!.name).toBe("DARK_MODE");
    expect(result.sharedFlags[0]!.repos).toEqual(["repo-a", "repo-b"]);
  });

  it("flags uncoordinated shared flags as warnings", async () => {
    const kv = new InMemoryKVStore();
    await setFlags(kv, "repo-a", ["FEATURE_X"]);
    await setFlags(kv, "repo-b", ["FEATURE_X"]);
    const repos = [makeRepo("repo-a"), makeRepo("repo-b")];

    const result = await detectCrossRepoFeatures(kv, repos, makeGraph());

    expect(result.sharedFlags[0]!.coordinated).toBe(false);
    const warnings = result.sarifResults.filter((r) => r.ruleId === "cross-repo/uncoordinated-flag");
    expect(warnings).toHaveLength(1);
  });

  it("marks coordinated flags when dependency edge exists", async () => {
    const kv = new InMemoryKVStore();
    await setFlags(kv, "repo-a", ["FEATURE_X"]);
    await setFlags(kv, "repo-b", ["FEATURE_X"]);
    const repos = [makeRepo("repo-a"), makeRepo("repo-b")];

    const result = await detectCrossRepoFeatures(kv, repos, makeGraph(["repo-a->repo-b"]));

    expect(result.sharedFlags[0]!.coordinated).toBe(true);
    const warnings = result.sarifResults.filter((r) => r.ruleId === "cross-repo/uncoordinated-flag");
    expect(warnings).toHaveLength(0);
  });

  it("ignores single-repo flags", async () => {
    const kv = new InMemoryKVStore();
    await setFlags(kv, "repo-a", ["ONLY_HERE"]);
    await setFlags(kv, "repo-b", ["DIFFERENT"]);
    const repos = [makeRepo("repo-a"), makeRepo("repo-b")];

    const result = await detectCrossRepoFeatures(kv, repos, makeGraph());

    expect(result.sharedFlags).toHaveLength(0);
    expect(result.sarifResults).toHaveLength(0);
  });

  it("handles partial coordination in 3+ repos", async () => {
    const kv = new InMemoryKVStore();
    await setFlags(kv, "repo-a", ["SHARED"]);
    await setFlags(kv, "repo-b", ["SHARED"]);
    await setFlags(kv, "repo-c", ["SHARED"]);
    const repos = [makeRepo("repo-a"), makeRepo("repo-b"), makeRepo("repo-c")];

    // Only a->b has an edge, not involving c
    const result = await detectCrossRepoFeatures(kv, repos, makeGraph(["repo-a->repo-b"]));

    expect(result.sharedFlags[0]!.repos).toHaveLength(3);
    // coordinated because at least one pair has an edge
    expect(result.sharedFlags[0]!.coordinated).toBe(true);
    // Should still produce shared-flag note but no uncoordinated warning
    const notes = result.sarifResults.filter((r) => r.ruleId === "cross-repo/shared-flag");
    expect(notes).toHaveLength(1);
  });
});
