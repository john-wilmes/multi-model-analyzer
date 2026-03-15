import { describe, it, expect } from "vitest";
import { getFlagInventory, computeFlagImpact } from "./flag-impact.js";
import { InMemoryGraphStore, InMemoryKVStore } from "@mma/storage";
import type { FlagInventory, GraphEdge } from "@mma/core";

function importEdge(source: string, target: string, repo = "repo"): GraphEdge {
  return { source, target, kind: "imports", metadata: { repo } };
}

function callEdge(source: string, target: string, repo = "repo"): GraphEdge {
  return { source, target, kind: "calls", metadata: { repo } };
}

function serviceEdge(source: string, target: string, repo = "repo"): GraphEdge {
  return { source, target, kind: "service-call", metadata: { repo } };
}

function makeInventory(repo: string, flags: Array<{ name: string; modules: string[]; sdk?: string }>): FlagInventory {
  return {
    repo,
    flags: flags.map((f) => ({
      name: f.name,
      sdk: f.sdk,
      locations: f.modules.map((m) => ({ repo, module: m })),
    })),
  };
}

describe("getFlagInventory", () => {
  it("returns empty result when no flags stored", async () => {
    const kv = new InMemoryKVStore();
    const result = await getFlagInventory(kv);
    expect(result.total).toBe(0);
    expect(result.flags).toEqual([]);
  });

  it("returns all flags across repos", async () => {
    const kv = new InMemoryKVStore();
    await kv.set("flags:repo-a", JSON.stringify(makeInventory("repo-a", [
      { name: "FEATURE_X", modules: ["x.ts"] },
    ])));
    await kv.set("flags:repo-b", JSON.stringify(makeInventory("repo-b", [
      { name: "FEATURE_Y", modules: ["y.ts", "z.ts"] },
    ])));

    const result = await getFlagInventory(kv);
    expect(result.total).toBe(2);
    expect(result.flags.map((f) => f.name).sort()).toEqual(["FEATURE_X", "FEATURE_Y"]);
  });

  it("filters by repo", async () => {
    const kv = new InMemoryKVStore();
    await kv.set("flags:repo-a", JSON.stringify(makeInventory("repo-a", [
      { name: "FLAG_A", modules: ["a.ts"] },
    ])));
    await kv.set("flags:repo-b", JSON.stringify(makeInventory("repo-b", [
      { name: "FLAG_B", modules: ["b.ts"] },
    ])));

    const result = await getFlagInventory(kv, { repo: "repo-a" });
    expect(result.total).toBe(1);
    expect(result.flags[0]!.name).toBe("FLAG_A");
  });

  it("filters by search substring", async () => {
    const kv = new InMemoryKVStore();
    await kv.set("flags:repo", JSON.stringify(makeInventory("repo", [
      { name: "FEATURE_DARK_MODE", modules: ["dark.ts"] },
      { name: "FEATURE_LIGHT_MODE", modules: ["light.ts"] },
      { name: "FF_BETA", modules: ["beta.ts"] },
    ])));

    const result = await getFlagInventory(kv, { search: "mode" });
    expect(result.total).toBe(2);
    expect(result.flags.every((f) => f.name.toLowerCase().includes("mode"))).toBe(true);
  });

  it("paginates results", async () => {
    const kv = new InMemoryKVStore();
    await kv.set("flags:repo", JSON.stringify(makeInventory("repo", [
      { name: "A", modules: ["a.ts"] },
      { name: "B", modules: ["b.ts"] },
      { name: "C", modules: ["c.ts"] },
    ])));

    const page1 = await getFlagInventory(kv, { limit: 2, offset: 0 });
    expect(page1.returned).toBe(2);
    expect(page1.hasMore).toBe(true);

    const page2 = await getFlagInventory(kv, { limit: 2, offset: 2 });
    expect(page2.returned).toBe(1);
    expect(page2.hasMore).toBe(false);
  });
});

describe("computeFlagImpact", () => {
  it("returns empty result when no inventory for repo", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();

    const result = await computeFlagImpact("FLAG_X", "repo", kv, graph);
    expect(result.totalAffected).toBe(0);
    expect(result.flagLocations).toEqual([]);
  });

  it("returns empty result when flag not found", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    await kv.set("flags:repo", JSON.stringify(makeInventory("repo", [
      { name: "FLAG_A", modules: ["a.ts"] },
    ])));

    const result = await computeFlagImpact("NONEXISTENT", "repo", kv, graph);
    expect(result.totalAffected).toBe(0);
  });

  it("finds flag by substring when exact match fails", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    await kv.set("flags:repo", JSON.stringify(makeInventory("repo", [
      { name: "FEATURE_DARK_MODE", modules: ["dark.ts"] },
    ])));
    await graph.addEdges([importEdge("consumer.ts", "dark.ts")]);

    const result = await computeFlagImpact("DARK_MODE", "repo", kv, graph);
    expect(result.flagName).toBe("FEATURE_DARK_MODE");
    expect(result.totalAffected).toBe(1);
  });

  it("finds single-hop reverse dependents", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    await kv.set("flags:repo", JSON.stringify(makeInventory("repo", [
      { name: "FLAG_X", modules: ["flag.ts"] },
    ])));
    await graph.addEdges([
      importEdge("a.ts", "flag.ts"),
      importEdge("b.ts", "flag.ts"),
    ]);

    const result = await computeFlagImpact("FLAG_X", "repo", kv, graph);
    expect(result.totalAffected).toBe(2);
    expect(result.affectedFiles.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
    expect(result.affectedFiles.every((f) => f.depth === 1)).toBe(true);
    expect(result.affectedFiles.every((f) => f.via === "imports")).toBe(true);
  });

  it("finds multi-hop transitive chain", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    await kv.set("flags:repo", JSON.stringify(makeInventory("repo", [
      { name: "FLAG_X", modules: ["flag.ts"] },
    ])));
    await graph.addEdges([
      importEdge("mid.ts", "flag.ts"),
      importEdge("top.ts", "mid.ts"),
    ]);

    const result = await computeFlagImpact("FLAG_X", "repo", kv, graph);
    expect(result.totalAffected).toBe(2);
    const mid = result.affectedFiles.find((f) => f.path === "mid.ts")!;
    const top = result.affectedFiles.find((f) => f.path === "top.ts")!;
    expect(mid.depth).toBe(1);
    expect(top.depth).toBe(2);
  });

  it("respects maxDepth limiting", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    await kv.set("flags:repo", JSON.stringify(makeInventory("repo", [
      { name: "FLAG_X", modules: ["flag.ts"] },
    ])));
    await graph.addEdges([
      importEdge("a.ts", "flag.ts"),
      importEdge("b.ts", "a.ts"),
      importEdge("c.ts", "b.ts"),
    ]);

    const result = await computeFlagImpact("FLAG_X", "repo", kv, graph, { maxDepth: 1 });
    expect(result.totalAffected).toBe(1);
    expect(result.affectedFiles[0]!.path).toBe("a.ts");
  });

  it("includes call graph edges when enabled", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    await kv.set("flags:repo", JSON.stringify(makeInventory("repo", [
      { name: "FLAG_X", modules: ["flag.ts"] },
    ])));
    await graph.addEdges([
      callEdge("caller.ts", "flag.ts"),
    ]);

    const withCalls = await computeFlagImpact("FLAG_X", "repo", kv, graph, { includeCallGraph: true });
    expect(withCalls.totalAffected).toBe(1);
    expect(withCalls.affectedFiles[0]!.via).toBe("calls");

    const withoutCalls = await computeFlagImpact("FLAG_X", "repo", kv, graph, { includeCallGraph: false });
    expect(withoutCalls.totalAffected).toBe(0);
  });

  it("marks 'both' when reached via imports AND calls", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    await kv.set("flags:repo", JSON.stringify(makeInventory("repo", [
      { name: "FLAG_X", modules: ["flag.ts"] },
    ])));
    await graph.addEdges([
      importEdge("consumer.ts", "flag.ts"),
      callEdge("consumer.ts", "flag.ts"),
    ]);

    const result = await computeFlagImpact("FLAG_X", "repo", kv, graph);
    expect(result.affectedFiles[0]!.via).toBe("both");
  });

  it("deduplicates diamond dependencies", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    await kv.set("flags:repo", JSON.stringify(makeInventory("repo", [
      { name: "FLAG_X", modules: ["flag.ts"] },
    ])));
    // Diamond: top -> left -> flag, top -> right -> flag
    await graph.addEdges([
      importEdge("left.ts", "flag.ts"),
      importEdge("right.ts", "flag.ts"),
      importEdge("top.ts", "left.ts"),
      importEdge("top.ts", "right.ts"),
    ]);

    const result = await computeFlagImpact("FLAG_X", "repo", kv, graph);
    const topFiles = result.affectedFiles.filter((f) => f.path === "top.ts");
    expect(topFiles).toHaveLength(1);
    expect(topFiles[0]!.depth).toBe(2);
  });

  it("excludes seed files from affected list", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    await kv.set("flags:repo", JSON.stringify(makeInventory("repo", [
      { name: "FLAG_X", modules: ["flag.ts"] },
    ])));
    await graph.addEdges([importEdge("a.ts", "flag.ts")]);

    const result = await computeFlagImpact("FLAG_X", "repo", kv, graph);
    expect(result.flagLocations).toEqual(["flag.ts"]);
    expect(result.affectedFiles.find((f) => f.path === "flag.ts")).toBeUndefined();
  });

  it("maps service-call edges from affected files", async () => {
    const kv = new InMemoryKVStore();
    const graph = new InMemoryGraphStore();
    await kv.set("flags:repo", JSON.stringify(makeInventory("repo", [
      { name: "FLAG_X", modules: ["flag.ts"] },
    ])));
    await graph.addEdges([
      importEdge("handler.ts", "flag.ts"),
      serviceEdge("handler.ts", "/api/users"),
      serviceEdge("unrelated.ts", "/api/other"),
    ]);

    const result = await computeFlagImpact("FLAG_X", "repo", kv, graph);
    expect(result.affectedServices).toHaveLength(1);
    expect(result.affectedServices[0]!.endpoint).toBe("/api/users");
    expect(result.affectedServices[0]!.sourceFile).toBe("handler.ts");
  });
});
