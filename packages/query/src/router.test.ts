import { describe, it, expect } from "vitest";
import { routeQuery } from "./router.js";

describe("routeQuery", () => {
  it("preserves PascalCase entities from original query", () => {
    const result = routeQuery("what calls UserService?");
    expect(result.extractedEntities).toContain("UserService");
    expect(result.route).toBe("structural");
  });

  it("extracts dotted paths", () => {
    const result = routeQuery("find auth.middleware.validate");
    expect(result.extractedEntities).toContain("auth.middleware.validate");
  });

  it("extracts quoted strings", () => {
    const result = routeQuery('find "error handling" in scheduler');
    expect(result.extractedEntities).toContain("error handling");
  });

  it("routes structural patterns correctly", () => {
    expect(routeQuery("what depends on core?").route).toBe("structural");
    expect(routeQuery("what imports Logger?").route).toBe("structural");
  });

  it("routes analytical patterns correctly", () => {
    expect(routeQuery("what are the risks?").route).toBe("analytical");
    expect(routeQuery("show dead code").route).toBe("analytical");
  });

  it("routes architecture patterns correctly", () => {
    expect(routeQuery("explain the architecture").route).toBe("architecture");
    expect(routeQuery("show architecture").route).toBe("architecture");
    expect(routeQuery("cross-repo topology").route).toBe("architecture");
    expect(routeQuery("service overview").route).toBe("architecture");
    expect(routeQuery("architecture overview").route).toBe("architecture");
  });

  it("does not route bare 'overview' to architecture", () => {
    expect(routeQuery("give me an overview").route).not.toBe("architecture");
  });

  it("routes synthesis patterns correctly", () => {
    expect(routeQuery("why does this exist?").route).toBe("synthesis");
    expect(routeQuery("explain the design").route).toBe("synthesis");
  });

  it("defaults to search", () => {
    expect(routeQuery("hello world").route).toBe("search");
  });

  it("extracts repo:NAME prefix", () => {
    const result = routeQuery("repo:twenty what depends on UserService");
    expect(result.repo).toBe("twenty");
    expect(result.strippedQuery).toBe("what depends on UserService");
    expect(result.route).toBe("structural");
    expect(result.extractedEntities).toContain("UserService");
  });

  it("returns undefined repo when no prefix", () => {
    const result = routeQuery("dependencies of UserService");
    expect(result.repo).toBeUndefined();
    expect(result.strippedQuery).toBe("dependencies of UserService");
    expect(result.route).toBe("structural");
  });

  it("handles repo prefix with search route", () => {
    const result = routeQuery("repo:myrepo hello world");
    expect(result.repo).toBe("myrepo");
    expect(result.route).toBe("search");
    expect(result.strippedQuery).toBe("hello world");
  });

  it("routes caller/callee/uses patterns to structural", () => {
    expect(routeQuery("callers of UserService").route).toBe("structural");
    expect(routeQuery("who uses AuthService").route).toBe("structural");
    expect(routeQuery("callees of main").route).toBe("structural");
    expect(routeQuery("show modules").route).toBe("structural");
  });

  it("routes diagnostic/warning/gap patterns to analytical", () => {
    expect(routeQuery("show diagnostics").route).toBe("analytical");
    expect(routeQuery("gaps in coverage").route).toBe("analytical");
    expect(routeQuery("missing tests").route).toBe("analytical");
    expect(routeQuery("show warnings").route).toBe("analytical");
    expect(routeQuery("open issues").route).toBe("analytical");
  });

  it("routes 'circular dependencies' to structural (dependencies trigger)", () => {
    expect(routeQuery("circular dependencies").route).toBe("structural");
  });

  it("extracts camelCase identifiers", () => {
    const result = routeQuery("what does renderToHTMLOrFlight call");
    expect(result.extractedEntities).toContain("renderToHTMLOrFlight");
    expect(result.route).toBe("structural");
  });
});
