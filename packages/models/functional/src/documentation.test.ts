/**
 * Tests for documentation generation and gap detection.
 */

import { describe, it, expect } from "vitest";
import type { ServiceCatalogEntry, Summary, SummaryTier } from "@mma/core";
import { generateDocumentation, findDocumentationGaps } from "./documentation.js";

function makeCatalogEntry(overrides: Partial<ServiceCatalogEntry> & { name: string }): ServiceCatalogEntry {
  return {
    purpose: "Handles requests",
    dependencies: [],
    apiSurface: [],
    errorHandlingSummary: "Returns 500 on error",
    ...overrides,
    rootPath: overrides.rootPath ?? overrides.name,
  };
}

function makeSummary(entityId: string, tier: SummaryTier): Summary {
  return { entityId, description: `Summary of ${entityId}`, tier, confidence: 0.8 };
}

describe("generateDocumentation", () => {
  it("produces markdown with header and service count", () => {
    const doc = generateDocumentation([], new Map());

    expect(doc).toContain("# System Architecture Documentation");
    expect(doc).toContain("Services: 0");
  });

  it("generates section for each service", () => {
    const catalog = [
      makeCatalogEntry({ name: "auth-service", purpose: "Handles authentication" }),
      makeCatalogEntry({ name: "db-service", purpose: "Database access" }),
    ];

    const doc = generateDocumentation(catalog, new Map());

    expect(doc).toContain("## auth-service");
    expect(doc).toContain("Handles authentication");
    expect(doc).toContain("## db-service");
    expect(doc).toContain("Database access");
  });

  it("includes dependencies list", () => {
    const catalog = [
      makeCatalogEntry({ name: "api", dependencies: ["redis", "postgres"] }),
    ];

    const doc = generateDocumentation(catalog, new Map());

    expect(doc).toContain("### Dependencies");
    expect(doc).toContain("- redis");
    expect(doc).toContain("- postgres");
  });

  it("includes API surface table", () => {
    const catalog = [
      makeCatalogEntry({
        name: "api",
        apiSurface: [
          { method: "GET", path: "/users", description: "List all users" },
          { method: "POST", path: "/users", description: "Create user" },
        ],
      }),
    ];

    const doc = generateDocumentation(catalog, new Map());

    expect(doc).toContain("### API Surface");
    expect(doc).toContain("| GET | /users | List all users |");
    expect(doc).toContain("| POST | /users | Create user |");
  });

  it("includes error handling summary", () => {
    const catalog = [
      makeCatalogEntry({ name: "api", errorHandlingSummary: "Retries 3 times then fails" }),
    ];

    const doc = generateDocumentation(catalog, new Map());

    expect(doc).toContain("### Error Handling");
    expect(doc).toContain("Retries 3 times then fails");
  });

  it("omits dependencies section when empty", () => {
    const catalog = [makeCatalogEntry({ name: "standalone", dependencies: [] })];

    const doc = generateDocumentation(catalog, new Map());

    expect(doc).not.toContain("### Dependencies");
  });

  it("omits API surface section when empty", () => {
    const catalog = [makeCatalogEntry({ name: "worker", apiSurface: [] })];

    const doc = generateDocumentation(catalog, new Map());

    expect(doc).not.toContain("### API Surface");
  });
});

describe("findDocumentationGaps", () => {
  it("reports undocumented service (no tier 4 summary)", () => {
    const catalog = [makeCatalogEntry({ name: "api" })];
    const summaries = new Map<string, Summary>();

    const results = findDocumentationGaps(catalog, summaries, "repo-a");

    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("functional/undocumented-service");
    expect(results[0]!.message.text).toContain("api");
  });

  it("does not report service with tier 4 summary", () => {
    const catalog = [makeCatalogEntry({ name: "api" })];
    const summaries = new Map<string, Summary>([
      ["service:api", makeSummary("service:api", 4)],
    ]);

    const results = findDocumentationGaps(catalog, summaries, "repo-a");

    const undocumented = results.filter((r) => r.ruleId === "functional/undocumented-service");
    expect(undocumented).toHaveLength(0);
  });

  it("reports endpoints with description matching path", () => {
    const catalog = [
      makeCatalogEntry({
        name: "api",
        apiSurface: [
          { method: "GET", path: "/users", description: "/users" }, // gap: desc === path
          { method: "POST", path: "/users", description: "Create a new user" }, // ok
        ],
      }),
    ];
    const summaries = new Map([["service:api", makeSummary("service:api", 4)]]);

    const results = findDocumentationGaps(catalog, summaries, "repo-a");

    const missing = results.filter((r) => r.ruleId === "functional/missing-api-description");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.message.text).toContain("GET /users");
  });

  it("returns empty when all documented", () => {
    const catalog = [
      makeCatalogEntry({
        name: "api",
        apiSurface: [{ method: "GET", path: "/health", description: "Health check endpoint" }],
      }),
    ];
    const summaries = new Map([["service:api", makeSummary("service:api", 4)]]);

    const results = findDocumentationGaps(catalog, summaries, "repo-a");

    expect(results).toHaveLength(0);
  });

  it("skips entries with empty name", () => {
    const catalog = [makeCatalogEntry({ name: "" })];

    const results = findDocumentationGaps(catalog, new Map(), "repo-a");

    expect(results).toHaveLength(0);
  });
});
