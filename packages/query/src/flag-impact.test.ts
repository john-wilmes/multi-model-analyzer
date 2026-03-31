import { describe, it, expect } from "vitest";
import { getFlagInventory, computeFlagImpact, getIntegratorConfigMap } from "./flag-impact.js";
import { InMemoryGraphStore, InMemoryKVStore } from "@mma/storage";
import type { FlagInventory, GraphEdge, ConfigInventory } from "@mma/core";

function importEdge(source: string, target: string, repo = "repo"): GraphEdge {
  return { source, target, kind: "imports", repo, metadata: { repo } };
}

function callEdge(source: string, target: string, repo = "repo"): GraphEdge {
  return { source, target, kind: "calls", repo, metadata: { repo } };
}

function serviceEdge(source: string, target: string, repo = "repo"): GraphEdge {
  return { source, target, kind: "service-call", repo, metadata: { repo } };
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

function makeConfigInventory(
  repo: string,
  params: Array<{
    name: string;
    kind: "setting" | "credential" | "flag";
    modules: string[];
    scope?: string;
  }>,
): ConfigInventory {
  return {
    repo,
    parameters: params.map((p) => ({
      name: p.name,
      kind: p.kind,
      locations: p.modules.map((m) => ({ repo, module: m })),
      ...(p.scope ? { scope: p.scope } : {}),
    })),
  };
}

describe("getIntegratorConfigMap", () => {
  it("returns empty result when no inventory stored", async () => {
    const kv = new InMemoryKVStore();
    const result = await getIntegratorConfigMap(kv);
    expect(result.total).toBe(0);
    expect(result.returned).toBe(0);
    expect(result.types).toEqual([]);
  });

  it("groups credentials and settings by integrator type from module path", async () => {
    const kv = new InMemoryKVStore();
    const repo = "integrator-service-clients";
    await kv.set(
      `config-inventory:${repo}`,
      JSON.stringify(makeConfigInventory(repo, [
        { name: "API_KEY", kind: "credential", modules: [`src/clients/athena/client.ts`] },
        { name: "BASE_URL", kind: "setting", modules: [`src/clients/athena/client.ts`] },
      ])),
    );

    const result = await getIntegratorConfigMap(kv);
    expect(result.total).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.types).toHaveLength(1);

    const athena = result.types[0]!;
    expect(athena.type).toBe("athena");
    expect(athena.credentials).toHaveLength(1);
    expect(athena.credentials[0]!.name).toBe("API_KEY");
    expect(athena.settings).toHaveLength(1);
    expect(athena.settings[0]!.name).toBe("BASE_URL");
  });

  it("excludes utility segments from integrator type extraction", async () => {
    const kv = new InMemoryKVStore();
    const repo = "integrator-service-clients";
    await kv.set(
      `config-inventory:${repo}`,
      JSON.stringify(makeConfigInventory(repo, [
        { name: "TIMEOUT", kind: "setting", modules: [`src/clients/shared/config.ts`] },
        { name: "UTIL_KEY", kind: "setting", modules: [`src/clients/utils/helper.ts`] },
        { name: "TEST_VAR", kind: "setting", modules: [`src/clients/__tests__/setup.ts`] },
        { name: "REAL_KEY", kind: "credential", modules: [`src/clients/epic/client.ts`] },
      ])),
    );

    const result = await getIntegratorConfigMap(kv);
    expect(result.total).toBe(1);
    expect(result.types[0]!.type).toBe("epic");
  });

  it("filters by type substring (case-insensitive)", async () => {
    const kv = new InMemoryKVStore();
    const repo = "integrator-service-clients";
    await kv.set(
      `config-inventory:${repo}`,
      JSON.stringify(makeConfigInventory(repo, [
        { name: "KEY_A", kind: "credential", modules: [`src/clients/athena/a.ts`] },
        { name: "KEY_B", kind: "credential", modules: [`src/clients/epic/b.ts`] },
      ])),
    );

    const result = await getIntegratorConfigMap(kv, { type: "ATH" });
    expect(result.total).toBe(2);
    expect(result.returned).toBe(1);
    expect(result.types[0]!.type).toBe("athena");
  });

  it("filters by search substring within parameter names (case-insensitive)", async () => {
    const kv = new InMemoryKVStore();
    const repo = "integrator-service-clients";
    await kv.set(
      `config-inventory:${repo}`,
      JSON.stringify(makeConfigInventory(repo, [
        { name: "API_KEY", kind: "credential", modules: [`src/clients/athena/a.ts`] },
        { name: "BASE_URL", kind: "setting", modules: [`src/clients/athena/a.ts`] },
        { name: "TIMEOUT", kind: "setting", modules: [`src/clients/athena/a.ts`] },
      ])),
    );

    const result = await getIntegratorConfigMap(kv, { search: "url" });
    expect(result.returned).toBe(1);
    const athena = result.types[0]!;
    expect(athena.credentials).toHaveLength(0);
    expect(athena.settings).toHaveLength(1);
    expect(athena.settings[0]!.name).toBe("BASE_URL");
  });

  it("attributes parameter to each matching integrator type when in multiple modules", async () => {
    const kv = new InMemoryKVStore();
    const repo = "integrator-service-clients";
    await kv.set(
      `config-inventory:${repo}`,
      JSON.stringify(makeConfigInventory(repo, [
        {
          name: "SHARED_SECRET",
          kind: "credential",
          modules: [
            `src/clients/athena/a.ts`,
            `src/clients/epic/b.ts`,
          ],
        },
      ])),
    );

    const result = await getIntegratorConfigMap(kv);
    expect(result.total).toBe(2);
    expect(result.types.map((t) => t.type).sort()).toEqual(["athena", "epic"]);
    for (const entry of result.types) {
      expect(entry.credentials).toHaveLength(1);
      expect(entry.credentials[0]!.name).toBe("SHARED_SECRET");
      // Each entry's modules should only contain paths for its own type
      for (const mod of entry.credentials[0]!.modules) {
        expect(mod).toContain(`clients/${entry.type}/`);
      }
    }
  });

  it("returns types sorted alphabetically", async () => {
    const kv = new InMemoryKVStore();
    const repo = "integrator-service-clients";
    await kv.set(
      `config-inventory:${repo}`,
      JSON.stringify(makeConfigInventory(repo, [
        { name: "Z_KEY", kind: "credential", modules: [`src/clients/zebra/z.ts`] },
        { name: "A_KEY", kind: "credential", modules: [`src/clients/alpha/a.ts`] },
        { name: "M_KEY", kind: "credential", modules: [`src/clients/middle/m.ts`] },
      ])),
    );

    const result = await getIntegratorConfigMap(kv);
    expect(result.types.map((t) => t.type)).toEqual(["alpha", "middle", "zebra"]);
  });

  it("search matching type name returns all params for that type", async () => {
    const kv = new InMemoryKVStore();
    const repo = "integrator-service-clients";
    await kv.set(
      `config-inventory:${repo}`,
      JSON.stringify(makeConfigInventory(repo, [
        { name: "API_KEY", kind: "credential", modules: [`src/clients/athena/a.ts`] },
        { name: "BASE_URL", kind: "setting", modules: [`src/clients/athena/a.ts`] },
        { name: "TIMEOUT", kind: "setting", modules: [`src/clients/epic/b.ts`] },
      ])),
    );

    const result = await getIntegratorConfigMap(kv, { search: "athena" });
    expect(result.returned).toBe(1);
    const athena = result.types[0]!;
    expect(athena.type).toBe("athena");
    expect(athena.credentials).toHaveLength(1);
    expect(athena.settings).toHaveLength(1);
  });

  it("excludes type when search filter removes all its parameters", async () => {
    const kv = new InMemoryKVStore();
    const repo = "integrator-service-clients";
    await kv.set(
      `config-inventory:${repo}`,
      JSON.stringify(makeConfigInventory(repo, [
        { name: "API_KEY", kind: "credential", modules: [`src/clients/athena/a.ts`] },
        { name: "BASE_URL", kind: "setting", modules: [`src/clients/epic/b.ts`] },
      ])),
    );

    const result = await getIntegratorConfigMap(kv, { search: "api_key" });
    expect(result.returned).toBe(1);
    expect(result.types[0]!.type).toBe("athena");
  });
});
