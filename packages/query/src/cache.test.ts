import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryCache } from "./cache.js";

describe("QueryCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves values", () => {
    const cache = new QueryCache<string>();
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("returns undefined for missing keys", () => {
    const cache = new QueryCache<string>();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("evicts LRU entry when at capacity", () => {
    const cache = new QueryCache<string>({ maxSize: 2 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3"); // should evict "a"

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
  });

  it("refreshes LRU order on get", () => {
    const cache = new QueryCache<string>({ maxSize: 2 });
    cache.set("a", "1");
    cache.set("b", "2");

    // Access "a" to make it most recently used
    cache.get("a");

    cache.set("c", "3"); // should evict "b" (LRU), not "a"

    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
  });

  it("expires entries after TTL", () => {
    const cache = new QueryCache<string>({ ttlMs: 1000 });
    cache.set("key", "value");

    expect(cache.get("key")).toBe("value");

    vi.advanceTimersByTime(1001);

    expect(cache.get("key")).toBeUndefined();
  });

  it("does not expire entries when TTL is 0", () => {
    const cache = new QueryCache<string>({ ttlMs: 0 });
    cache.set("key", "value");

    vi.advanceTimersByTime(999_999);

    expect(cache.get("key")).toBe("value");
  });

  it("updates value for existing key", () => {
    const cache = new QueryCache<string>();
    cache.set("key", "old");
    cache.set("key", "new");

    expect(cache.get("key")).toBe("new");
    expect(cache.size).toBe(1);
  });

  it("has() returns true for existing, false for missing", () => {
    const cache = new QueryCache<string>();
    cache.set("key", "value");

    expect(cache.has("key")).toBe(true);
    expect(cache.has("missing")).toBe(false);
  });

  it("delete() removes a specific key", () => {
    const cache = new QueryCache<string>();
    cache.set("a", "1");
    cache.set("b", "2");

    cache.delete("a");

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.size).toBe(1);
  });

  it("clear() removes all entries", () => {
    const cache = new QueryCache<string>();
    cache.set("a", "1");
    cache.set("b", "2");

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("buildKey produces deterministic keys", () => {
    expect(QueryCache.buildKey(["callers", "UserService", "repo-a"])).toBe(
      "callers::UserService::repo-a",
    );
    expect(QueryCache.buildKey(["search", "auth", undefined])).toBe(
      "search::auth::",
    );
  });

  it("handles capacity of 1", () => {
    const cache = new QueryCache<string>({ maxSize: 1 });
    cache.set("a", "1");
    cache.set("b", "2");

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.size).toBe(1);
  });
});
