/**
 * Tests for functional model query classification and execution.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { ServiceCatalogEntry, Summary } from "@mma/core";
import { InMemorySearchStore } from "@mma/storage";
import { classifyQuery, executeQuery } from "./query.js";

function makeCatalogEntry(overrides: Partial<ServiceCatalogEntry> & { name: string }): ServiceCatalogEntry {
  return {
    purpose: "Default purpose",
    dependencies: [],
    apiSurface: [],
    errorHandlingSummary: "No error logging detected",
    ...overrides,
    rootPath: overrides.rootPath ?? overrides.name,
  };
}

describe("classifyQuery", () => {
  it("classifies structural queries", () => {
    expect(classifyQuery("what calls handleRequest")).toBe("structural");
    expect(classifyQuery("show imports for utils")).toBe("structural");
    expect(classifyQuery("depends on database")).toBe("structural");
    expect(classifyQuery("show the call graph")).toBe("structural");
  });

  it("classifies analytical queries", () => {
    expect(classifyQuery("show risk assessment")).toBe("analytical");
    expect(classifyQuery("what is the fault")).toBe("analytical");
    expect(classifyQuery("find the error in code")).toBe("analytical");
    expect(classifyQuery("flag configuration")).toBe("analytical");
  });

  it("defaults to search for general queries", () => {
    expect(classifyQuery("authentication logic")).toBe("search");
    expect(classifyQuery("how does the system work")).toBe("search");
    expect(classifyQuery("find the login handler")).toBe("search");
  });
});

describe("executeQuery", () => {
  let searchStore: InMemorySearchStore;
  const emptySummaries = new Map<string, Summary>();

  beforeEach(async () => {
    searchStore = new InMemorySearchStore();
  });

  it("executes search queries against search store", async () => {
    await searchStore.index([
      { id: "auth.ts#login", content: "handles user authentication and login", metadata: {} },
    ]);

    const result = await executeQuery("authentication", searchStore, [], emptySummaries);

    expect(result.kind).toBe("search");
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("returns empty search results gracefully", async () => {
    const result = await executeQuery("nonexistent topic", searchStore, [], emptySummaries);

    expect(result.kind).toBe("search");
    expect(result.answer).toContain("No matching results");
    expect(result.confidence).toBe(0);
  });

  it("executes structural queries against catalog", async () => {
    const catalog = [
      makeCatalogEntry({ name: "auth-service", purpose: "Authentication", dependencies: ["redis", "postgres"] }),
    ];

    const result = await executeQuery("what depends on auth-service", searchStore, catalog, emptySummaries);

    expect(result.kind).toBe("structural");
    expect(result.answer).toContain("auth-service");
    expect(result.answer).toContain("redis");
    expect(result.sources).toHaveLength(1);
  });

  it("returns no-match for structural query with no catalog hit", async () => {
    const result = await executeQuery("what calls nonexistent", searchStore, [], emptySummaries);

    expect(result.kind).toBe("structural");
    expect(result.answer).toContain("No structural information found");
    expect(result.confidence).toBe(0);
  });

  it("executes analytical queries for services with error handling", async () => {
    const catalog = [
      makeCatalogEntry({ name: "api", errorHandlingSummary: "Retries 3 times, then returns 500" }),
      makeCatalogEntry({ name: "worker", errorHandlingSummary: "No error logging detected" }),
    ];

    const result = await executeQuery("show risk analysis", searchStore, catalog, emptySummaries);

    expect(result.kind).toBe("analytical");
    expect(result.answer).toContain("api");
    expect(result.answer).toContain("Retries 3 times");
    // worker is filtered out (errorHandlingSummary matches "No error logging detected")
    expect(result.answer).not.toContain("worker");
  });

  it("returns empty analytical result when no error handling data", async () => {
    const catalog = [
      makeCatalogEntry({ name: "clean", errorHandlingSummary: "No error logging detected" }),
    ];

    const result = await executeQuery("show fault analysis", searchStore, catalog, emptySummaries);

    expect(result.kind).toBe("analytical");
    expect(result.answer).toContain("No analytical data available");
  });
});
