/**
 * Storage round-trip tests across KV and Graph backends.
 *
 * Tests InMemoryKVStore and InMemoryGraphStore with write/read/delete
 * cycles, JSON serialisation, and non-existent key semantics.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryKVStore, InMemoryGraphStore } from "@mma/storage";
import type { GraphEdge } from "@mma/core";

// ---------------------------------------------------------------------------
// KV round-trip
// ---------------------------------------------------------------------------

describe("InMemoryKVStore round-trip", () => {
  let kv: InMemoryKVStore;

  beforeEach(() => {
    kv = new InMemoryKVStore();
  });

  it("write then read returns the same value", async () => {
    await kv.set("key:1", "hello");
    expect(await kv.get("key:1")).toBe("hello");
  });

  it("delete removes the key so subsequent get returns undefined", async () => {
    await kv.set("del-key", "value");
    await kv.delete("del-key");
    expect(await kv.get("del-key")).toBeUndefined();
  });

  it("overwrite replaces the previous value", async () => {
    await kv.set("ow-key", "first");
    await kv.set("ow-key", "second");
    expect(await kv.get("ow-key")).toBe("second");
  });

  it("non-existent key returns undefined", async () => {
    expect(await kv.get("no-such-key")).toBeUndefined();
  });

  it("JSON serialization round-trip through KV store", async () => {
    const payload = { repo: "my-repo", count: 42, tags: ["a", "b"] };
    await kv.set("json:key", JSON.stringify(payload));
    const raw = await kv.get("json:key");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as typeof payload;
    expect(parsed.repo).toBe("my-repo");
    expect(parsed.count).toBe(42);
    expect(parsed.tags).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Graph round-trip
// ---------------------------------------------------------------------------

describe("InMemoryGraphStore round-trip", () => {
  let graph: InMemoryGraphStore;

  beforeEach(() => {
    graph = new InMemoryGraphStore();
  });

  it("addEdges then getEdgesFrom returns the stored edges", async () => {
    const edges: GraphEdge[] = [
      { source: "src/a.ts", target: "src/b.ts", kind: "imports" },
      { source: "src/a.ts", target: "src/c.ts", kind: "imports" },
    ];

    await graph.addEdges(edges);

    const result = await graph.getEdgesFrom("src/a.ts");
    expect(result).toHaveLength(2);
    const targets = result.map((e) => e.target).sort();
    expect(targets).toEqual(["src/b.ts", "src/c.ts"]);
  });
});
