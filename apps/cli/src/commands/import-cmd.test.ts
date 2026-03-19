import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { InMemoryKVStore, InMemoryGraphStore } from "@mma/storage";
import { importCommand } from "./import-cmd.js";
import { exportCommand } from "./export-cmd.js";
import type { ExportManifest } from "./export-cmd.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePath(): string {
  return join(
    tmpdir(),
    `mma-import-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function makeStores() {
  return {
    kvStore: new InMemoryKVStore(),
    graphStore: new InMemoryGraphStore(),
  };
}

async function seedRepo(
  kv: InMemoryKVStore,
  graph: InMemoryGraphStore,
  repo: string,
): Promise<void> {
  await kv.set(`commit:${repo}`, "abc123");
  await kv.set(
    `metricsSummary:${repo}`,
    JSON.stringify({ repo, moduleCount: 2 }),
  );
  await kv.set(
    `metrics:${repo}`,
    JSON.stringify([{ module: "src/api.ts", repo }]),
  );
  await kv.set(`symbols:${repo}:src/api.ts`, JSON.stringify([{ name: "getUser" }]));
  await kv.set(`pipelineComplete:${repo}`, "true");

  await graph.addEdges([
    {
      source: `${repo}/src/api.ts`,
      target: `${repo}/src/auth.ts`,
      kind: "imports",
      metadata: { repo },
    },
  ]);
}

/**
 * Create a minimal SQLite DB with the MMA export schema.
 * Optionally inserts a manifest KV entry.
 */
function createTestDb(
  path: string,
  manifest?: Partial<ExportManifest>,
): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, metadata TEXT);
  `);
  if (manifest) {
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(
      "mma:manifest",
      JSON.stringify(manifest),
    );
  }
  // Add a sample KV entry
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(
    "test:key",
    "test-value",
  );
  db.close();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("importCommand", () => {
  let srcPath: string;
  let kvStore: InMemoryKVStore;
  let graphStore: InMemoryGraphStore;

  beforeEach(() => {
    srcPath = makePath();
    const stores = makeStores();
    kvStore = stores.kvStore;
    graphStore = stores.graphStore;
  });

  afterEach(() => {
    try {
      unlinkSync(srcPath);
    } catch {
      /* ignore */
    }
  });

  it("imports all KV entries from raw export into empty store", async () => {
    // Build a raw export as the source
    const srcKv = new InMemoryKVStore();
    const srcGraph = new InMemoryGraphStore();
    await seedRepo(srcKv, srcGraph, "acme-corp");
    await exportCommand({
      kvStore: srcKv,
      graphStore: srcGraph,
      output: srcPath,
      salt: "s",
      raw: true,
    });

    await importCommand({ kvStore, graphStore, input: srcPath });

    // commit key should have been imported
    const commit = await kvStore.get("commit:acme-corp");
    expect(commit).toBe("abc123");

    // metricsSummary key should be present
    const metricsSummary = await kvStore.get("metricsSummary:acme-corp");
    expect(metricsSummary).toBeDefined();
  });

  it("imports edges into graph store", async () => {
    const srcKv = new InMemoryKVStore();
    const srcGraph = new InMemoryGraphStore();
    await seedRepo(srcKv, srcGraph, "edge-repo");
    await exportCommand({
      kvStore: srcKv,
      graphStore: srcGraph,
      output: srcPath,
      salt: "s",
      raw: true,
    });

    const result = await importCommand({ kvStore, graphStore, input: srcPath });

    expect(result.edgeCount).toBe(1);

    const edges = await graphStore.getEdgesByKind("imports", "edge-repo");
    expect(edges.length).toBe(1);
    expect(edges[0]!.source).toBe("edge-repo/src/api.ts");
    expect(edges[0]!.target).toBe("edge-repo/src/auth.ts");
  });

  it("preserves commit, symbols, pipelineComplete keys", async () => {
    const srcKv = new InMemoryKVStore();
    const srcGraph = new InMemoryGraphStore();
    await seedRepo(srcKv, srcGraph, "my-repo");
    await exportCommand({
      kvStore: srcKv,
      graphStore: srcGraph,
      output: srcPath,
      salt: "s",
      raw: true,
    });

    await importCommand({ kvStore, graphStore, input: srcPath });

    const allKeys = await kvStore.keys();
    expect(allKeys.some((k) => k.startsWith("commit:"))).toBe(true);
    expect(allKeys.some((k) => k.startsWith("symbols:"))).toBe(true);
    expect(allKeys.some((k) => k.startsWith("pipelineComplete:"))).toBe(true);
  });

  it("rejects missing manifest", async () => {
    createTestDb(srcPath); // no manifest argument → no mma:manifest row

    await expect(
      importCommand({ kvStore, graphStore, input: srcPath }),
    ).rejects.toThrow("Not a valid MMA export");
  });

  it("rejects anonymized export", async () => {
    createTestDb(srcPath, {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      mode: "anonymized",
      repos: [],
    });

    await expect(
      importCommand({ kvStore, graphStore, input: srcPath }),
    ).rejects.toThrow("Cannot import anonymized export");
  });

  it("rejects unsupported schema version", async () => {
    createTestDb(srcPath, {
      schemaVersion: 99,
      exportedAt: new Date().toISOString(),
      mode: "raw",
      repos: [],
    });

    await expect(
      importCommand({ kvStore, graphStore, input: srcPath }),
    ).rejects.toThrow("Unsupported schema version 99");
  });

  it("warns on repo mismatch", async () => {
    const srcKv = new InMemoryKVStore();
    const srcGraph = new InMemoryGraphStore();
    await seedRepo(srcKv, srcGraph, "exported-repo");
    await exportCommand({
      kvStore: srcKv,
      graphStore: srcGraph,
      output: srcPath,
      salt: "s",
      raw: true,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await importCommand({
        kvStore,
        graphStore,
        input: srcPath,
        configRepos: ["completely-different-repo"],
      });

      // "exported-repo" is in the export but not in configRepos
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("exported-repo"),
      );
      // "completely-different-repo" is in configRepos but not in the export
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("completely-different-repo"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not clear pre-existing local data", async () => {
    // Pre-populate local store with unrelated data
    await kvStore.set("pre-existing:key", "should-survive");

    const srcKv = new InMemoryKVStore();
    const srcGraph = new InMemoryGraphStore();
    await seedRepo(srcKv, srcGraph, "new-repo");
    await exportCommand({
      kvStore: srcKv,
      graphStore: srcGraph,
      output: srcPath,
      salt: "s",
      raw: true,
    });

    await importCommand({ kvStore, graphStore, input: srcPath });

    // Pre-existing data must still be present
    const preExisting = await kvStore.get("pre-existing:key");
    expect(preExisting).toBe("should-survive");

    // Imported data is also present
    const imported = await kvStore.get("commit:new-repo");
    expect(imported).toBe("abc123");
  });
});
