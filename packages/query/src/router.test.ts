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

  it("routes synthesis patterns correctly", () => {
    expect(routeQuery("explain the architecture").route).toBe("synthesis");
    expect(routeQuery("why does this exist?").route).toBe("synthesis");
  });

  it("defaults to search", () => {
    expect(routeQuery("hello world").route).toBe("search");
  });
});
