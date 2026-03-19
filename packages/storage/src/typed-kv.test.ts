/**
 * Tests for createTypedKVStore: typed wrapper over raw KV with JSON serialization.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryKVStore, createTypedKVStore } from "./kv.js";
import type { TypedKVStore } from "./kv.js";

interface Widget {
  id: number;
  name: string;
  tags: string[];
}

describe("createTypedKVStore", () => {
  let raw: InMemoryKVStore;
  let typed: TypedKVStore<Widget>;

  beforeEach(() => {
    raw = new InMemoryKVStore();
    typed = createTypedKVStore<Widget>(raw, "widgets");
  });

  it("stores and retrieves typed values", async () => {
    const widget: Widget = { id: 1, name: "sprocket", tags: ["mechanical"] };
    await typed.set("w1", widget);

    const result = await typed.get("w1");
    expect(result).toEqual(widget);
  });

  it("returns undefined for missing keys", async () => {
    const result = await typed.get("missing");
    expect(result).toBeUndefined();
  });

  it("prefixes keys in the underlying store", async () => {
    await typed.set("w1", { id: 1, name: "a", tags: [] });

    // Raw store should have the prefixed key
    const raw_value = await raw.get("widgets:w1");
    expect(raw_value).toBeDefined();
    expect(JSON.parse(raw_value!)).toEqual({ id: 1, name: "a", tags: [] });

    // Unprefixed key should not exist
    const unprefixed = await raw.get("w1");
    expect(unprefixed).toBeUndefined();
  });

  it("deletes typed values", async () => {
    await typed.set("w1", { id: 1, name: "a", tags: [] });
    await typed.delete("w1");

    expect(await typed.get("w1")).toBeUndefined();
    expect(await raw.get("widgets:w1")).toBeUndefined();
  });

  it("checks existence with has()", async () => {
    expect(await typed.has("w1")).toBe(false);

    await typed.set("w1", { id: 1, name: "a", tags: [] });
    expect(await typed.has("w1")).toBe(true);
  });

  it("isolates different prefixes", async () => {
    const typed2 = createTypedKVStore<Widget>(raw, "gadgets");

    await typed.set("x", { id: 1, name: "widget-x", tags: [] });
    await typed2.set("x", { id: 2, name: "gadget-x", tags: [] });

    const w = await typed.get("x");
    const g = await typed2.get("x");

    expect(w!.name).toBe("widget-x");
    expect(g!.name).toBe("gadget-x");
  });

  it("roundtrips complex nested objects", async () => {
    const complex: Widget = {
      id: 42,
      name: "complex widget",
      tags: ["a", "b", "c"],
    };
    await typed.set("complex", complex);

    const result = await typed.get("complex");
    expect(result).toEqual(complex);
    expect(result!.tags).toHaveLength(3);
  });
});
