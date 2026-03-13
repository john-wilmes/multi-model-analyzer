/**
 * Tests for SqliteKVStore: get/set/delete/has, prefix-based key listing,
 * deleteByPrefix, upsert behavior, and clear.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteStores } from "./sqlite-common.js";
import type { KVStore } from "./kv.js";

describe("SqliteKVStore", () => {
  let kvStore: KVStore;
  let cleanup: () => void;

  beforeEach(() => {
    const stores = createSqliteStores({ dbPath: ":memory:" });
    kvStore = stores.kvStore;
    cleanup = () => stores.close();
  });

  afterEach(() => {
    cleanup();
  });

  describe("get / set", () => {
    it("returns undefined for missing key", async () => {
      const result = await kvStore.get("missing");
      expect(result).toBeUndefined();
    });

    it("stores and retrieves a value", async () => {
      await kvStore.set("key1", "value1");
      const result = await kvStore.get("key1");
      expect(result).toBe("value1");
    });

    it("overwrites existing key (upsert)", async () => {
      await kvStore.set("key1", "old");
      await kvStore.set("key1", "new");
      const result = await kvStore.get("key1");
      expect(result).toBe("new");
    });

    it("handles JSON values", async () => {
      const data = JSON.stringify({ count: 42, items: ["a", "b"] });
      await kvStore.set("json-key", data);
      const raw = await kvStore.get("json-key");
      expect(JSON.parse(raw!)).toEqual({ count: 42, items: ["a", "b"] });
    });

    it("handles empty string values", async () => {
      await kvStore.set("empty", "");
      const result = await kvStore.get("empty");
      expect(result).toBe("");
    });
  });

  describe("has", () => {
    it("returns false for missing key", async () => {
      expect(await kvStore.has("nope")).toBe(false);
    });

    it("returns true for existing key", async () => {
      await kvStore.set("exists", "yes");
      expect(await kvStore.has("exists")).toBe(true);
    });
  });

  describe("delete", () => {
    it("removes a key", async () => {
      await kvStore.set("key1", "value1");
      await kvStore.delete("key1");
      expect(await kvStore.get("key1")).toBeUndefined();
    });

    it("is a no-op for missing key", async () => {
      await expect(kvStore.delete("missing")).resolves.toBeUndefined();
    });
  });

  describe("keys", () => {
    it("returns all keys when no prefix", async () => {
      await kvStore.set("alpha", "1");
      await kvStore.set("beta", "2");
      await kvStore.set("gamma", "3");

      const keys = await kvStore.keys();
      expect(keys).toHaveLength(3);
      expect(keys).toContain("alpha");
      expect(keys).toContain("beta");
      expect(keys).toContain("gamma");
    });

    it("returns keys matching prefix", async () => {
      await kvStore.set("sarif:config:r1", "1");
      await kvStore.set("sarif:config:r2", "2");
      await kvStore.set("sarif:fault:r1", "3");
      await kvStore.set("commit:r1", "4");

      const configKeys = await kvStore.keys("sarif:config:");
      expect(configKeys).toHaveLength(2);
      expect(configKeys).toContain("sarif:config:r1");
      expect(configKeys).toContain("sarif:config:r2");
    });

    it("returns empty array when no keys match prefix", async () => {
      await kvStore.set("foo:bar", "1");
      const result = await kvStore.keys("baz:");
      expect(result).toEqual([]);
    });

    it("returns keys in sorted order", async () => {
      await kvStore.set("c", "3");
      await kvStore.set("a", "1");
      await kvStore.set("b", "2");

      const keys = await kvStore.keys();
      expect(keys).toEqual(["a", "b", "c"]);
    });
  });

  describe("deleteByPrefix", () => {
    it("deletes keys matching prefix and returns count", async () => {
      await kvStore.set("symbols:r1:a.ts", "1");
      await kvStore.set("symbols:r1:b.ts", "2");
      await kvStore.set("symbols:r2:c.ts", "3");
      await kvStore.set("commit:r1", "4");

      const deleted = await kvStore.deleteByPrefix("symbols:r1:");
      expect(deleted).toBe(2);

      expect(await kvStore.has("symbols:r1:a.ts")).toBe(false);
      expect(await kvStore.has("symbols:r2:c.ts")).toBe(true);
      expect(await kvStore.has("commit:r1")).toBe(true);
    });

    it("empty prefix clears all keys", async () => {
      await kvStore.set("a", "1");
      await kvStore.set("b", "2");

      const deleted = await kvStore.deleteByPrefix("");
      expect(deleted).toBe(2);
      expect(await kvStore.keys()).toEqual([]);
    });

    it("returns 0 when no keys match", async () => {
      await kvStore.set("keep", "1");
      const deleted = await kvStore.deleteByPrefix("remove:");
      expect(deleted).toBe(0);
    });
  });

  describe("clear", () => {
    it("removes all entries", async () => {
      await kvStore.set("a", "1");
      await kvStore.set("b", "2");

      await kvStore.clear();

      expect(await kvStore.keys()).toEqual([]);
    });
  });
});
