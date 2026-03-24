import { describe, it, expect } from "vitest";
import { buildExportIndex, resolveSymbolsOnEdges } from "./symbol-resolver.js";
import type { ExportIndex, PackageEntryMap } from "./symbol-resolver.js";
import type { ResolvedCrossRepoEdge } from "./types.js";
import type { RepoConfig } from "@mma/core";
import { InMemoryKVStore } from "@mma/storage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEdge(
  source: string,
  target: string,
  meta: Record<string, unknown> = {},
  overrides: Partial<Pick<ResolvedCrossRepoEdge, "sourceRepo" | "targetRepo" | "packageName">> = {},
): ResolvedCrossRepoEdge {
  return {
    edge: { source, target, kind: "imports", metadata: { ...meta } },
    sourceRepo: overrides.sourceRepo ?? "repo-a",
    targetRepo: overrides.targetRepo ?? "repo-b",
    packageName: overrides.packageName ?? "@acme/lib",
  };
}

function makeRepo(name: string): RepoConfig {
  return { name, url: `https://github.com/acme/${name}`, localPath: `/tmp/${name}`, branch: "main" };
}

// ---------------------------------------------------------------------------
// buildExportIndex
// ---------------------------------------------------------------------------

describe("buildExportIndex", () => {
  it("returns empty map for empty KV store", async () => {
    const kvStore = new InMemoryKVStore();
    const index = await buildExportIndex(kvStore, [makeRepo("repo-a")]);
    expect(index.size).toBe(0);
  });

  it("indexes only exported symbols", async () => {
    const kvStore = new InMemoryKVStore();
    await kvStore.set(
      "symbols:repo-a:src/util.ts",
      JSON.stringify({
        contentHash: "abc",
        symbols: [
          { name: "createClient", kind: "function", exported: true, startLine: 1, endLine: 5 },
          { name: "_internal", kind: "function", exported: false, startLine: 7, endLine: 10 },
        ],
      }),
    );

    const index = await buildExportIndex(kvStore, [makeRepo("repo-a")]);
    const fileExports = index.get("repo-a:src/util.ts");
    expect(fileExports).toBeDefined();
    expect(fileExports!.has("createClient")).toBe(true);
    expect(fileExports!.has("_internal")).toBe(false);
  });

  it("records symbol kind for exported symbols", async () => {
    const kvStore = new InMemoryKVStore();
    await kvStore.set(
      "symbols:repo-a:src/types.ts",
      JSON.stringify({
        contentHash: "xyz",
        symbols: [
          { name: "SupabaseClient", kind: "class", exported: true, startLine: 1, endLine: 50 },
        ],
      }),
    );

    const index = await buildExportIndex(kvStore, [makeRepo("repo-a")]);
    const fileExports = index.get("repo-a:src/types.ts");
    expect(fileExports!.get("SupabaseClient")).toEqual({ kind: "class" });
  });

  it("skips files with malformed JSON without throwing", async () => {
    const kvStore = new InMemoryKVStore();
    await kvStore.set("symbols:repo-a:src/broken.ts", "not valid json{{");
    await kvStore.set(
      "symbols:repo-a:src/good.ts",
      JSON.stringify({
        contentHash: "ok",
        symbols: [{ name: "Foo", kind: "class", exported: true, startLine: 1, endLine: 5 }],
      }),
    );

    const index = await buildExportIndex(kvStore, [makeRepo("repo-a")]);
    expect(index.has("repo-a:src/broken.ts")).toBe(false);
    expect(index.has("repo-a:src/good.ts")).toBe(true);
  });

  it("omits files with no exported symbols from the index", async () => {
    const kvStore = new InMemoryKVStore();
    await kvStore.set(
      "symbols:repo-a:src/internal.ts",
      JSON.stringify({
        contentHash: "abc",
        symbols: [
          { name: "helper", kind: "function", exported: false, startLine: 1, endLine: 3 },
        ],
      }),
    );

    const index = await buildExportIndex(kvStore, [makeRepo("repo-a")]);
    expect(index.has("repo-a:src/internal.ts")).toBe(false);
  });

  it("processes multiple repos independently", async () => {
    const kvStore = new InMemoryKVStore();
    await kvStore.set(
      "symbols:repo-a:src/a.ts",
      JSON.stringify({
        contentHash: "aaa",
        symbols: [{ name: "Alpha", kind: "class", exported: true, startLine: 1, endLine: 5 }],
      }),
    );
    await kvStore.set(
      "symbols:repo-b:src/b.ts",
      JSON.stringify({
        contentHash: "bbb",
        symbols: [{ name: "Beta", kind: "function", exported: true, startLine: 1, endLine: 3 }],
      }),
    );

    const index = await buildExportIndex(kvStore, [makeRepo("repo-a"), makeRepo("repo-b")]);
    expect(index.has("repo-a:src/a.ts")).toBe(true);
    expect(index.has("repo-b:src/b.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveSymbolsOnEdges
// ---------------------------------------------------------------------------

describe("resolveSymbolsOnEdges", () => {
  function makeExportIndex(entries: Array<[string, Array<[string, string]>]>): ExportIndex {
    const index: ExportIndex = new Map();
    for (const [fileId, symbols] of entries) {
      const symMap = new Map(symbols.map(([name, kind]) => [name, { kind }]));
      index.set(fileId, symMap);
    }
    return index;
  }

  it("resolves a direct named import to its exported symbol", () => {
    const exportIndex = makeExportIndex([
      ["repo-b:src/client.ts", [["createClient", "function"]]],
    ]);
    const edges = [makeEdge("repo-a:src/app.ts", "repo-b:src/client.ts", { importedNames: ["createClient"] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, new Map());

    expect(count).toBe(1);
    const resolved = edges[0]!.edge.metadata!.resolvedSymbols as Array<{ name: string; targetFileId: string; kind: string }>;
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual({ name: "createClient", targetFileId: "repo-b:src/client.ts", kind: "function" });
  });

  it("does not set resolvedSymbols when symbol not found in target", () => {
    const exportIndex = makeExportIndex([
      ["repo-b:src/client.ts", [["createClient", "function"]]],
    ]);
    const edges = [makeEdge("repo-a:src/app.ts", "repo-b:src/client.ts", { importedNames: ["nonExistent"] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, new Map());

    expect(count).toBe(0);
    expect(edges[0]!.edge.metadata!.resolvedSymbols).toBeUndefined();
  });

  it("resolves multiple named imports in a single edge", () => {
    const exportIndex = makeExportIndex([
      ["repo-b:src/utils.ts", [["alpha", "function"], ["beta", "const"]]],
    ]);
    const edges = [makeEdge("repo-a:src/app.ts", "repo-b:src/utils.ts", { importedNames: ["alpha", "beta"] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, new Map());

    expect(count).toBe(2);
    const resolved = edges[0]!.edge.metadata!.resolvedSymbols as Array<{ name: string }>;
    expect(resolved.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("resolves default import to explicit 'default' export", () => {
    const exportIndex = makeExportIndex([
      ["repo-b:src/svc.ts", [["default", "class"]]],
    ]);
    const edges = [makeEdge("repo-a:src/app.ts", "repo-b:src/svc.ts", { importedNames: ["default"] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, new Map());

    expect(count).toBe(1);
    const resolved = edges[0]!.edge.metadata!.resolvedSymbols as Array<{ name: string; kind: string }>;
    expect(resolved[0]!.name).toBe("default");
    expect(resolved[0]!.kind).toBe("class");
  });

  it("resolves default import via fallback to first export when no explicit default", () => {
    const exportIndex = makeExportIndex([
      ["repo-b:src/svc.ts", [["MyService", "class"]]],
    ]);
    const edges = [makeEdge("repo-a:src/app.ts", "repo-b:src/svc.ts", { importedNames: ["default"] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, new Map());

    expect(count).toBe(1);
    const resolved = edges[0]!.edge.metadata!.resolvedSymbols as Array<{ name: string }>;
    expect(resolved[0]!.name).toBe("MyService");
  });

  it("resolves namespace import '*' to all exports from target", () => {
    const exportIndex = makeExportIndex([
      ["repo-b:src/lib.ts", [["foo", "function"], ["bar", "const"]]],
    ]);
    const edges = [makeEdge("repo-a:src/app.ts", "repo-b:src/lib.ts", { importedNames: ["*"] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, new Map());

    expect(count).toBe(2);
    const resolved = edges[0]!.edge.metadata!.resolvedSymbols as Array<{ name: string }>;
    expect(resolved.map((r) => r.name).sort()).toEqual(["bar", "foo"]);
  });

  it("resolves named import via one-hop barrel resolution", () => {
    // Edge targets a barrel (repo-b:src/index.ts) which re-exports from repo-b:src/client.ts.
    // The barrel itself has no direct exports in the index.
    const exportIndex = makeExportIndex([
      ["repo-b:src/client.ts", [["createClient", "function"]]],
    ]);
    const barrelSources = new Map([["repo-b:src/index.ts", ["repo-b:src/client.ts"]]]);
    const edges = [makeEdge("repo-a:src/app.ts", "repo-b:src/index.ts", { importedNames: ["createClient"] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, barrelSources);

    expect(count).toBe(1);
    const resolved = edges[0]!.edge.metadata!.resolvedSymbols as Array<{ name: string; targetFileId: string }>;
    expect(resolved[0]!.name).toBe("createClient");
    // Resolved to the actual source file, not the barrel
    expect(resolved[0]!.targetFileId).toBe("repo-b:src/client.ts");
  });

  it("resolves '*' namespace import to include barrel re-export sources", () => {
    const exportIndex = makeExportIndex([
      ["repo-b:src/index.ts", [["fromBarrel", "const"]]],
      ["repo-b:src/extra.ts", [["fromExtra", "function"]]],
    ]);
    const barrelSources = new Map([["repo-b:src/index.ts", ["repo-b:src/extra.ts"]]]);
    const edges = [makeEdge("repo-a:src/app.ts", "repo-b:src/index.ts", { importedNames: ["*"] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, barrelSources);

    expect(count).toBe(2);
    const resolved = edges[0]!.edge.metadata!.resolvedSymbols as Array<{ name: string }>;
    expect(resolved.map((r) => r.name).sort()).toEqual(["fromBarrel", "fromExtra"]);
  });

  it("skips edges with no importedNames metadata", () => {
    const exportIndex = makeExportIndex([
      ["repo-b:src/lib.ts", [["foo", "function"]]],
    ]);
    const edges = [makeEdge("repo-a:src/app.ts", "repo-b:src/lib.ts")];

    const count = resolveSymbolsOnEdges(edges, exportIndex, new Map());

    expect(count).toBe(0);
    expect(edges[0]!.edge.metadata!.resolvedSymbols).toBeUndefined();
  });

  it("skips edges with empty importedNames array", () => {
    const exportIndex = makeExportIndex([
      ["repo-b:src/lib.ts", [["foo", "function"]]],
    ]);
    const edges = [makeEdge("repo-a:src/app.ts", "repo-b:src/lib.ts", { importedNames: [] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, new Map());

    expect(count).toBe(0);
    expect(edges[0]!.edge.metadata!.resolvedSymbols).toBeUndefined();
  });

  it("returns total resolved count across multiple edges", () => {
    const exportIndex = makeExportIndex([
      ["repo-b:src/a.ts", [["Alpha", "class"]]],
      ["repo-b:src/b.ts", [["beta", "function"]]],
    ]);
    const edges = [
      makeEdge("repo-a:src/x.ts", "repo-b:src/a.ts", { importedNames: ["Alpha"] }),
      makeEdge("repo-a:src/y.ts", "repo-b:src/b.ts", { importedNames: ["beta"] }),
    ];

    const count = resolveSymbolsOnEdges(edges, exportIndex, new Map());

    expect(count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Package specifier resolution via packageEntryMap
  // -------------------------------------------------------------------------

  it("resolves named import from npm package specifier via packageEntryMap", () => {
    const exportIndex = makeExportIndex([
      ["repo-b:src/index.ts", [["createClient", "function"], ["Session", "interface"]]],
    ]);
    const packageEntryMap: PackageEntryMap = new Map([
      ["@acme/lib", ["repo-b:src/index.ts"]],
    ]);
    const edges = [makeEdge("repo-a:src/app.ts", "@acme/lib", { importedNames: ["createClient"] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, new Map(), packageEntryMap);

    expect(count).toBe(1);
    const resolved = edges[0]!.edge.metadata!.resolvedSymbols as Array<{ name: string; targetFileId: string; kind: string }>;
    expect(resolved[0]).toEqual({ name: "createClient", targetFileId: "repo-b:src/index.ts", kind: "function" });
  });

  it("resolves deep import subpath to candidate file ID", () => {
    const exportIndex = makeExportIndex([
      ["repo-b:out/constants.ts", [["MAX_RETRIES", "const"]]],
    ]);
    const edges = [makeEdge("repo-a:src/app.ts", "@acme/lib/out/constants", { importedNames: ["MAX_RETRIES"] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, new Map(), new Map());

    expect(count).toBe(1);
    const resolved = edges[0]!.edge.metadata!.resolvedSymbols as Array<{ name: string; targetFileId: string }>;
    expect(resolved[0]!.targetFileId).toBe("repo-b:out/constants.ts");
  });

  it("resolves deep import subpath with /index.ts fallback", () => {
    const exportIndex = makeExportIndex([
      ["repo-b:utils/index.ts", [["helper", "function"]]],
    ]);
    const edges = [makeEdge("repo-a:src/app.ts", "@acme/lib/utils", { importedNames: ["helper"] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, new Map(), new Map());

    expect(count).toBe(1);
    const resolved = edges[0]!.edge.metadata!.resolvedSymbols as Array<{ name: string; targetFileId: string }>;
    expect(resolved[0]!.targetFileId).toBe("repo-b:utils/index.ts");
  });

  it("resolves barrel package via packageEntryMap with barrel sources", () => {
    // Package entry is a barrel that re-exports from another file
    const exportIndex = makeExportIndex([
      ["repo-b:src/client.ts", [["createClient", "function"]]],
    ]);
    const barrelSources = new Map([["repo-b:src/index.ts", ["repo-b:src/client.ts"]]]);
    const packageEntryMap: PackageEntryMap = new Map([
      ["@acme/lib", ["repo-b:src/index.ts"]],
    ]);
    const edges = [makeEdge("repo-a:src/app.ts", "@acme/lib", { importedNames: ["createClient"] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, barrelSources, packageEntryMap);

    expect(count).toBe(1);
    const resolved = edges[0]!.edge.metadata!.resolvedSymbols as Array<{ name: string; targetFileId: string }>;
    expect(resolved[0]!.name).toBe("createClient");
    expect(resolved[0]!.targetFileId).toBe("repo-b:src/client.ts");
  });

  it("gracefully handles unresolvable package specifier", () => {
    const exportIndex = makeExportIndex([]);
    const edges = [makeEdge("repo-a:src/app.ts", "@unknown/pkg", { importedNames: ["Foo"] })];

    const count = resolveSymbolsOnEdges(edges, exportIndex, new Map(), new Map());

    expect(count).toBe(0);
    expect(edges[0]!.edge.metadata!.resolvedSymbols).toBeUndefined();
  });
});
