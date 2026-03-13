import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { InMemoryKVStore, InMemoryGraphStore } from "@mma/storage";
import type { SarifLog } from "@mma/core";
import { exportCommand } from "./export-cmd.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    JSON.stringify({
      repo,
      moduleCount: 2,
      avgInstability: 0.5,
      avgAbstractness: 0.3,
      avgDistance: 0.2,
      painZoneCount: 1,
      uselessnessZoneCount: 0,
    }),
  );

  await kv.set(
    `metrics:${repo}`,
    JSON.stringify([
      {
        module: "src/api.ts",
        repo,
        ca: 1,
        ce: 2,
        instability: 0.67,
        abstractness: 0,
        distance: 0.33,
        zone: "main-sequence",
      },
      {
        module: "src/auth.ts",
        repo,
        ca: 2,
        ce: 1,
        instability: 0.33,
        abstractness: 0.5,
        distance: 0.17,
        zone: "balanced",
      },
    ]),
  );

  await kv.set(
    `patterns:${repo}`,
    JSON.stringify([
      {
        kind: "factory",
        name: "AuthServiceFactory",
        locations: [],
        confidence: 0.9,
      },
    ]),
  );

  // These should be skipped
  await kv.set(`symbols:${repo}:src/api.ts`, JSON.stringify([{ name: "getUser" }]));
  await kv.set(`pipelineComplete:${repo}`, "true");

  // SARIF
  const sarifLog: SarifLog = {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: { name: "multi-model-analyzer", version: "0.1.0", rules: [] },
        },
        results: [
          {
            ruleId: "structural/dead-export",
            level: "warning",
            message: { text: `Dead export in ${repo}/src/old.ts` },
          },
        ],
      },
    ],
  };
  await kv.set("sarif:latest", JSON.stringify(sarifLog));

  // Graph edges
  await graph.addEdges([
    {
      source: `${repo}/src/api.ts`,
      target: `${repo}/src/auth.ts`,
      kind: "imports",
      metadata: { repo },
    },
    {
      source: `${repo}/src/auth.ts`,
      target: `${repo}/src/types.ts`,
      kind: "imports",
      metadata: { repo },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("exportCommand", () => {
  let kvStore: InMemoryKVStore;
  let graphStore: InMemoryGraphStore;
  let outputPath: string;

  beforeEach(() => {
    const stores = makeStores();
    kvStore = stores.kvStore;
    graphStore = stores.graphStore;
    outputPath = join(tmpdir(), `mma-export-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  });

  afterEach(() => {
    try {
      unlinkSync(outputPath);
    } catch {
      /* ignore */
    }
  });

  it("exports anonymized KV entries without real repo names", async () => {
    await seedRepo(kvStore, graphStore, "acme-corp");
    await exportCommand({
      kvStore,
      graphStore,
      output: outputPath,
      salt: "test-salt",
    });

    const db = new Database(outputPath, { readonly: true });
    const keys = (
      db.prepare("SELECT key FROM kv").all() as Array<{ key: string }>
    ).map((r) => r.key);

    // No real repo name in any key
    expect(keys.every((k) => !k.includes("acme-corp"))).toBe(true);

    // No symbols or pipelineComplete keys
    expect(keys.every((k) => !k.startsWith("symbols:"))).toBe(true);
    expect(keys.every((k) => !k.startsWith("pipelineComplete:"))).toBe(true);

    // Values don't contain real names or file paths
    const values = (
      db.prepare("SELECT value FROM kv").all() as Array<{ value: string }>
    ).map((r) => r.value);
    const allValues = values.join(" ");
    expect(allValues).not.toContain("acme-corp");
    expect(allValues).not.toContain("src/api.ts");
    expect(allValues).not.toContain("src/auth.ts");

    db.close();
  });

  it("exports anonymized edges", async () => {
    await seedRepo(kvStore, graphStore, "acme-corp");
    const result = await exportCommand({
      kvStore,
      graphStore,
      output: outputPath,
      salt: "test-salt",
    });

    const db = new Database(outputPath, { readonly: true });

    // Edge count matches source
    expect(result.edgeCount).toBe(2);
    const count = (
      db.prepare("SELECT count(*) as cnt FROM edges").get() as { cnt: number }
    ).cnt;
    expect(count).toBe(2);

    // No real names in edges
    const edges = db
      .prepare("SELECT source, target, kind, metadata FROM edges")
      .all() as Array<{
      source: string;
      target: string;
      kind: string;
      metadata: string;
    }>;

    for (const edge of edges) {
      expect(edge.source).not.toContain("acme-corp");
      expect(edge.target).not.toContain("acme-corp");
      expect(edge.metadata).not.toContain("acme-corp");
      // Source/target should be [REDACTED:...] tokens
      expect(edge.source).toMatch(/^\[REDACTED:[0-9a-f]+\]$/);
      expect(edge.target).toMatch(/^\[REDACTED:[0-9a-f]+\]$/);
    }

    // Edge kind is preserved
    const kinds = edges.map((e) => e.kind);
    expect(kinds.every((k) => k === "imports")).toBe(true);

    db.close();
  });

  it("preserves numeric metric values", async () => {
    await seedRepo(kvStore, graphStore, "test-repo");
    await exportCommand({
      kvStore,
      graphStore,
      output: outputPath,
      salt: "s",
    });

    const db = new Database(outputPath, { readonly: true });
    const rows = db.prepare("SELECT key, value FROM kv").all() as Array<{
      key: string;
      value: string;
    }>;

    // Find a metrics entry (key prefix "metrics:" but not "metricsSummary:")
    const metricsRow = rows.find(
      (r) => r.key.startsWith("metrics:") && !r.key.startsWith("metricsSummary:"),
    );
    expect(metricsRow).toBeDefined();

    const modules = JSON.parse(metricsRow!.value) as Array<{
      instability: number;
      ca: number;
    }>;
    // Numeric values preserved
    expect(modules[0]!.instability).toBe(0.67);
    expect(modules[0]!.ca).toBe(1);

    db.close();
  });

  it("preserves SARIF rule IDs", async () => {
    await seedRepo(kvStore, graphStore, "secret-project");
    await exportCommand({
      kvStore,
      graphStore,
      output: outputPath,
      salt: "salt",
    });

    const db = new Database(outputPath, { readonly: true });
    const sarifRow = db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get("sarif:latest") as { value: string } | undefined;

    expect(sarifRow).toBeDefined();
    expect(sarifRow!.value).toContain("structural/dead-export");
    // But no real repo name
    expect(sarifRow!.value).not.toContain("secret-project");

    db.close();
  });

  it("produces a valid export for empty database", async () => {
    const result = await exportCommand({
      kvStore,
      graphStore,
      output: outputPath,
      salt: "s",
    });

    expect(result.kvCount).toBe(0);
    expect(result.edgeCount).toBe(0);

    const db = new Database(outputPath, { readonly: true });
    const kvCount = (
      db.prepare("SELECT count(*) as cnt FROM kv").get() as { cnt: number }
    ).cnt;
    const edgeCount = (
      db.prepare("SELECT count(*) as cnt FROM edges").get() as { cnt: number }
    ).cnt;
    expect(kvCount).toBe(0);
    expect(edgeCount).toBe(0);
    db.close();
  });

  it("handles multiple repos consistently", async () => {
    await seedRepo(kvStore, graphStore, "alpha-svc");
    await seedRepo(kvStore, graphStore, "bravo-api");
    await exportCommand({
      kvStore,
      graphStore,
      output: outputPath,
      salt: "multi",
    });

    const db = new Database(outputPath, { readonly: true });
    const keys = (
      db.prepare("SELECT key FROM kv").all() as Array<{ key: string }>
    ).map((r) => r.key);

    // Neither repo name appears
    expect(keys.every((k) => !k.includes("alpha-svc"))).toBe(true);
    expect(keys.every((k) => !k.includes("bravo-api"))).toBe(true);

    // Edge count: 2 per repo × 2 repos = 4
    const edgeCount = (
      db.prepare("SELECT count(*) as cnt FROM edges").get() as { cnt: number }
    ).cnt;
    expect(edgeCount).toBe(4);

    db.close();
  });
});
