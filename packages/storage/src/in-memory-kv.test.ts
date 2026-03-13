/**
 * Tests for InMemoryKVStore: get/set/delete, prefix keys, deleteByPrefix, has, clear.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryKVStore } from "./kv.js";

describe("InMemoryKVStore", () => {
  let store: InMemoryKVStore;

  beforeEach(() => {
    store = new InMemoryKVStore();
  });

  describe("get / set", () => {
    it("returns undefined for missing key", async () => {
      expect(await store.get("missing")).toBeUndefined();
    });

    it("stores and retrieves a value", async () => {
      await store.set("k1", "v1");
      expect(await store.get("k1")).toBe("v1");
    });

    it("overwrites existing value", async () => {
      await store.set("k1", "old");
      await store.set("k1", "new");
      expect(await store.get("k1")).toBe("new");
    });
  });

  describe("has", () => {
    it("returns false for missing key", async () => {
      expect(await store.has("nope")).toBe(false);
    });

    it("returns true for existing key", async () => {
      await store.set("exists", "1");
      expect(await store.has("exists")).toBe(true);
    });
  });

  describe("delete", () => {
    it("removes an existing key", async () => {
      await store.set("k1", "v1");
      await store.delete("k1");
      expect(await store.get("k1")).toBeUndefined();
    });
  });

  describe("keys", () => {
    it("returns all keys when no prefix", async () => {
      await store.set("a", "1");
      await store.set("b", "2");
      const keys = await store.keys();
      expect(keys).toHaveLength(2);
    });

    it("returns only keys matching prefix", async () => {
      await store.set("sarif:config:r1", "1");
      await store.set("sarif:fault:r1", "2");
      await store.set("commit:r1", "3");

      const keys = await store.keys("sarif:");
      expect(keys).toHaveLength(2);
      expect(keys.every((k) => k.startsWith("sarif:"))).toBe(true);
    });

    it("returns empty array when no keys match", async () => {
      await store.set("foo", "1");
      expect(await store.keys("bar:")).toEqual([]);
    });
  });

  describe("deleteByPrefix", () => {
    it("deletes matching keys and returns count", async () => {
      await store.set("symbols:r1:a", "1");
      await store.set("symbols:r1:b", "2");
      await store.set("commit:r1", "3");

      const count = await store.deleteByPrefix("symbols:r1:");
      expect(count).toBe(2);
      expect(await store.has("commit:r1")).toBe(true);
    });

    it("returns 0 when no keys match", async () => {
      await store.set("keep", "1");
      expect(await store.deleteByPrefix("remove:")).toBe(0);
    });
  });

  describe("clear / close", () => {
    it("clear removes all entries", async () => {
      await store.set("a", "1");
      await store.set("b", "2");
      await store.clear();
      expect(await store.keys()).toEqual([]);
    });

    it("close empties the store", async () => {
      await store.set("a", "1");
      await store.close();
      expect(await store.get("a")).toBeUndefined();
    });
  });
});
