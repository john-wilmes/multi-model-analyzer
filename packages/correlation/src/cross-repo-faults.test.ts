/**
 * Tests for cross-repo fault propagation detection.
 */

import { describe, it, expect } from "vitest";
import { InMemoryKVStore } from "@mma/storage";
import type { RepoConfig, FaultTree } from "@mma/core";
import { detectCrossRepoFaults } from "./cross-repo-faults.js";
import type { ServiceCorrelationResult, ServiceLink } from "./types.js";

const makeRepo = (name: string): RepoConfig => ({
  name,
  url: `https://github.com/org/${name}`,
  branch: "main",
  localPath: `/repos/${name}`,
});

function makeFaultTree(repo: string, label: string): FaultTree {
  return {
    repo,
    topEvent: {
      id: `${repo}-${label}`,
      label,
      kind: "or-gate",
      children: [{ id: `${repo}-basic`, label: "basic event", kind: "basic-event", children: [] }],
    },
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

function makeCorrelation(links: ServiceLink[]): ServiceCorrelationResult {
  return { links, linchpins: [], orphanedServices: [] };
}

describe("detectCrossRepoFaults", () => {
  it("detects cascading faults between linked repos", async () => {
    const kv = new InMemoryKVStore();
    await kv.set("faultTrees:repo-a", JSON.stringify([makeFaultTree("repo-a", "crash")]));
    await kv.set("faultTrees:repo-b", JSON.stringify([makeFaultTree("repo-b", "timeout")]));

    const correlation = makeCorrelation([
      makeServiceLink("/api/data", ["repo-a"], ["repo-b"]),
    ]);

    const result = await detectCrossRepoFaults(kv, [makeRepo("repo-a"), makeRepo("repo-b")], correlation);

    expect(result.faultLinks).toHaveLength(1);
    expect(result.faultLinks[0]!.endpoint).toBe("/api/data");
    expect(result.faultLinks[0]!.sourceRepo).toBe("repo-a");
    expect(result.faultLinks[0]!.targetRepo).toBe("repo-b");
    expect(result.sarifResults).toHaveLength(1);
    expect(result.sarifResults[0]!.ruleId).toBe("cross-repo/cascading-fault");
  });

  it("skips when only one side has fault trees", async () => {
    const kv = new InMemoryKVStore();
    await kv.set("faultTrees:repo-a", JSON.stringify([makeFaultTree("repo-a", "crash")]));
    // repo-b has no fault trees

    const correlation = makeCorrelation([
      makeServiceLink("/api/data", ["repo-a"], ["repo-b"]),
    ]);

    const result = await detectCrossRepoFaults(kv, [makeRepo("repo-a"), makeRepo("repo-b")], correlation);

    expect(result.faultLinks).toHaveLength(0);
    expect(result.sarifResults).toHaveLength(0);
  });

  it("returns empty when no fault trees exist", async () => {
    const kv = new InMemoryKVStore();
    const correlation = makeCorrelation([
      makeServiceLink("/api/data", ["repo-a"], ["repo-b"]),
    ]);

    const result = await detectCrossRepoFaults(kv, [makeRepo("repo-a"), makeRepo("repo-b")], correlation);

    expect(result.faultLinks).toHaveLength(0);
    expect(result.sarifResults).toHaveLength(0);
  });

  it("handles multi-tree callee repo", async () => {
    const kv = new InMemoryKVStore();
    await kv.set("faultTrees:repo-a", JSON.stringify([makeFaultTree("repo-a", "crash")]));
    await kv.set("faultTrees:repo-b", JSON.stringify([
      makeFaultTree("repo-b", "timeout"),
      makeFaultTree("repo-b", "OOM"),
    ]));

    const correlation = makeCorrelation([
      makeServiceLink("/api/data", ["repo-a"], ["repo-b"]),
    ]);

    const result = await detectCrossRepoFaults(kv, [makeRepo("repo-a"), makeRepo("repo-b")], correlation);

    expect(result.faultLinks).toHaveLength(1);
    expect(result.faultLinks[0]!.targetFaultTreeCount).toBe(2);
  });

  it("filters to relevant repos only", async () => {
    const kv = new InMemoryKVStore();
    await kv.set("faultTrees:repo-a", JSON.stringify([makeFaultTree("repo-a", "crash")]));
    await kv.set("faultTrees:repo-b", JSON.stringify([makeFaultTree("repo-b", "timeout")]));
    await kv.set("faultTrees:repo-c", JSON.stringify([makeFaultTree("repo-c", "error")]));

    // Only repo-a produces, repo-b consumes
    const correlation = makeCorrelation([
      makeServiceLink("/api/data", ["repo-a"], ["repo-b"]),
    ]);

    // repo-c is indexed but not linked
    const result = await detectCrossRepoFaults(
      kv,
      [makeRepo("repo-a"), makeRepo("repo-b"), makeRepo("repo-c")],
      correlation,
    );

    expect(result.faultLinks).toHaveLength(1);
    // Only a->b, not involving c
    expect(result.faultLinks[0]!.sourceRepo).toBe("repo-a");
    expect(result.faultLinks[0]!.targetRepo).toBe("repo-b");
  });
});
