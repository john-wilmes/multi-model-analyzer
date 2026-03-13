import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeCommand } from "./merge-cmd.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createExportDb(filePath: string, kvRows: Array<[string, string]>, edgeRows: Array<{ source: string; target: string; kind: string; metadata?: string }>): void {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      metadata TEXT
    );
  `);
  const insertKv = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)");
  const insertEdge = db.prepare("INSERT INTO edges (source, target, kind, metadata) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (const [k, v] of kvRows) insertKv.run(k, v);
    for (const e of edgeRows) insertEdge.run(e.source, e.target, e.kind, e.metadata ?? null);
  })();
  db.close();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mergeCommand", () => {
  let tmpDir: string;
  const tmps: string[] = [];

  function tmp(name: string): string {
    if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), "mma-merge-test-"));
    const p = join(tmpDir, name);
    tmps.push(p);
    return p;
  }

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
      tmps.length = 0;
    }
  });

  it("merges kv entries from two DBs (last wins for duplicates)", async () => {
    const a = tmp("a.db");
    const b = tmp("b.db");
    const out = tmp("out.db");

    createExportDb(a, [["key1", "val1"], ["shared", "from-a"]], []);
    createExportDb(b, [["key2", "val2"], ["shared", "from-b"]], []);

    const result = await mergeCommand([a, b], out);

    expect(result.kvCount).toBe(3); // key1, key2, shared
    expect(result.edgeCount).toBe(0);

    const db = new Database(out, { readonly: true });
    const rows = db.prepare("SELECT key, value FROM kv ORDER BY key").all() as Array<{ key: string; value: string }>;
    db.close();

    expect(rows).toEqual([
      { key: "key1", value: "val1" },
      { key: "key2", value: "val2" },
      { key: "shared", value: "from-b" }, // last wins
    ]);
  });

  it("merges edges from two DBs", async () => {
    const a = tmp("a.db");
    const b = tmp("b.db");
    const out = tmp("out.db");

    createExportDb(a, [], [
      { source: "a", target: "b", kind: "imports" },
    ]);
    createExportDb(b, [], [
      { source: "c", target: "d", kind: "calls" },
      { source: "e", target: "f", kind: "imports" },
    ]);

    const result = await mergeCommand([a, b], out);

    expect(result.edgeCount).toBe(3);

    const db = new Database(out, { readonly: true });
    const edges = db.prepare("SELECT source, target, kind FROM edges ORDER BY source").all() as Array<{ source: string; target: string; kind: string }>;
    db.close();

    expect(edges).toEqual([
      { source: "a", target: "b", kind: "imports" },
      { source: "c", target: "d", kind: "calls" },
      { source: "e", target: "f", kind: "imports" },
    ]);
  });

  it("merges sarif:latest runs from two DBs", async () => {
    const a = tmp("a.db");
    const b = tmp("b.db");
    const out = tmp("out.db");

    const sarifA = JSON.stringify({
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "mma" } }, results: [{ ruleId: "rule-A" }] }],
    });
    const sarifB = JSON.stringify({
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "mma" } }, results: [{ ruleId: "rule-B" }] }],
    });

    createExportDb(a, [["sarif:latest", sarifA]], []);
    createExportDb(b, [["sarif:latest", sarifB]], []);

    await mergeCommand([a, b], out);

    const db = new Database(out, { readonly: true });
    const row = db.prepare("SELECT value FROM kv WHERE key = 'sarif:latest'").get() as { value: string } | undefined;
    db.close();

    expect(row).toBeDefined();
    const merged = JSON.parse(row!.value) as { runs: unknown[] };
    expect(merged.runs).toHaveLength(2);
  });

  it("handles one empty DB and one with data", async () => {
    const empty = tmp("empty.db");
    const full = tmp("full.db");
    const out = tmp("out.db");

    createExportDb(empty, [], []);
    createExportDb(full, [["key1", "val1"]], [{ source: "x", target: "y", kind: "imports" }]);

    const result = await mergeCommand([empty, full], out);

    expect(result.kvCount).toBe(1);
    expect(result.edgeCount).toBe(1);
  });

  it("throws when an input file does not exist", async () => {
    const out = tmp("out.db");
    await expect(mergeCommand(["/nonexistent/path.db"], out)).rejects.toThrow(
      "Input file not found",
    );
  });
});
