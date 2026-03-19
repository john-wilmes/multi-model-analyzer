/**
 * Tests for search query execution via BM25.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemorySearchStore } from "@mma/storage";
import { executeSearchQuery } from "./search.js";

describe("executeSearchQuery", () => {
  let searchStore: InMemorySearchStore;

  beforeEach(async () => {
    searchStore = new InMemorySearchStore();
    await searchStore.index([
      { id: "auth.ts#login", content: "user authentication login handler", metadata: {} },
      { id: "auth.ts#logout", content: "user logout and session cleanup", metadata: {} },
      { id: "db.ts#connect", content: "database connection pool manager", metadata: {} },
    ]);
  });

  it("returns matching results", async () => {
    const result = await executeSearchQuery("authentication", searchStore);

    expect(result.returnedCount).toBeGreaterThan(0);
    expect(result.results.length).toBe(result.returnedCount);
    expect(result.description).toContain("authentication");
  });

  it("returns empty results for no match", async () => {
    const result = await executeSearchQuery("nonexistent-xyz", searchStore);

    expect(result.returnedCount).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it("respects the limit parameter", async () => {
    const result = await executeSearchQuery("user", searchStore, 1);

    expect(result.returnedCount).toBeLessThanOrEqual(1);
  });

  it("includes repo in description when specified", async () => {
    const result = await executeSearchQuery("login", searchStore, 10, "my-repo");

    expect(result.description).toContain("my-repo");
  });

  it("omits repo from description when not specified", async () => {
    const result = await executeSearchQuery("login", searchStore);

    expect(result.description).not.toContain("repo:");
  });
});
