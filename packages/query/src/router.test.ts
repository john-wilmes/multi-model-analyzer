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
    expect(routeQuery("narrate architecture").route).toBe("synthesis");
    expect(routeQuery("narration for nest").route).toBe("synthesis");
    expect(routeQuery("give me a narrative overview").route).toBe("synthesis");
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

  it("routes pattern queries correctly", () => {
    expect(routeQuery("find patterns").route).toBe("pattern");
    expect(routeQuery("show factories").route).toBe("pattern");
    expect(routeQuery("list singletons").route).toBe("pattern");
    expect(routeQuery("show adapters").route).toBe("pattern");
    expect(routeQuery("find middleware").route).toBe("pattern");
    expect(routeQuery("what decorators exist").route).toBe("pattern");
    expect(routeQuery("find repositories").route).toBe("pattern");
  });

  it("routes documentation queries correctly", () => {
    expect(routeQuery("show docs").route).toBe("documentation");
    expect(routeQuery("documentation for worker").route).toBe("documentation");
    expect(routeQuery("docs for novu-api").route).toBe("documentation");
  });

  it("routes fault tree queries correctly", () => {
    expect(routeQuery("fault trees").route).toBe("faulttree");
    expect(routeQuery("show fault tree").route).toBe("faulttree");
    expect(routeQuery("failure paths in api").route).toBe("faulttree");
    expect(routeQuery("failure analysis").route).toBe("faulttree");
    expect(routeQuery("basic events").route).toBe("faulttree");
  });

  it("routes 'faults' (not 'fault tree') to analytical", () => {
    expect(routeQuery("show faults").route).toBe("analytical");
    expect(routeQuery("what are the faults").route).toBe("analytical");
  });

  it("routes flag impact queries to flagimpact", () => {
    expect(routeQuery("flag impact of ENABLE_DARK_MODE").route).toBe("flagimpact");
    expect(routeQuery("feature flags").route).toBe("flagimpact");
    expect(routeQuery("show feature flag inventory").route).toBe("flagimpact");
    expect(routeQuery("flag analysis").route).toBe("flagimpact");
  });

  it("does not route non-flag impact queries to flagimpact", () => {
    // "what is the impact of changing X" has no "flag" keyword — should be blastradius
    expect(routeQuery("what is the impact of changing X").route).toBe("blastradius");
  });

  // Bug #8: query router misfires on 4 query types
  it("routes 'cross-repo dependencies' to architecture, not structural", () => {
    // architecture check must precede structural so "cross-repo" wins over "dependencies"
    expect(routeQuery("cross-repo dependencies").route).toBe("architecture");
    expect(routeQuery("show cross-repo dependency graph").route).toBe("architecture");
  });

  it("routes complexity queries to blastradius (hotspots)", () => {
    expect(routeQuery("most complex files").route).toBe("blastradius");
    expect(routeQuery("show file complexity").route).toBe("blastradius");
    expect(routeQuery("highest complexity modules").route).toBe("blastradius");
  });

  it("routes 'repository pattern' to pattern, not structural", () => {
    // pattern check must precede structural to avoid ambiguous term confusion
    expect(routeQuery("repository pattern classes").route).toBe("pattern");
    expect(routeQuery("find repository patterns").route).toBe("pattern");
  });

  it("routes temporal queries to analytical", () => {
    expect(routeQuery("recent changes to auth").route).toBe("analytical");
    expect(routeQuery("recently updated files").route).toBe("analytical");
    expect(routeQuery("what was modified last commit").route).toBe("analytical");
    expect(routeQuery("history of payments module").route).toBe("analytical");
  });
});
