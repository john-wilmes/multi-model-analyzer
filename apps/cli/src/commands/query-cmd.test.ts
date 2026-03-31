/**
 * Tests for queryCommand: validates all query routes produce correct output
 * in table, JSON, and SARIF formats.
 *
 * Mocks @mma/query to control routing and query execution.
 * Uses InMemory stores for KV/graph/search state.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RouteDecision } from "@mma/query";
import {
  InMemoryGraphStore,
  InMemorySearchStore,
  InMemoryKVStore,
} from "@mma/storage";
import { queryCommand, type QueryOptions } from "./query-cmd.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@mma/query", () => ({
  routeQuery: vi.fn(),
  executeSearchQuery: vi.fn(),
  executeCallersQuery: vi.fn(),
  executeCalleesQuery: vi.fn(),
  executeDependencyQuery: vi.fn(),
  executeArchitectureQuery: vi.fn(),
  computeFlagImpact: vi.fn(),
  getFlagInventory: vi.fn(),
}));

import {
  routeQuery,
  executeSearchQuery,
  executeCallersQuery,
  executeCalleesQuery,
  executeDependencyQuery,
  executeArchitectureQuery,
  computeFlagImpact,
  getFlagInventory,
} from "@mma/query";

const mockRouteQuery = routeQuery as ReturnType<typeof vi.fn>;
const mockExecuteSearch = executeSearchQuery as ReturnType<typeof vi.fn>;
const mockExecuteCallers = executeCallersQuery as ReturnType<typeof vi.fn>;
const mockExecuteCallees = executeCalleesQuery as ReturnType<typeof vi.fn>;
const mockExecuteDeps = executeDependencyQuery as ReturnType<typeof vi.fn>;
const mockExecuteArch = executeArchitectureQuery as ReturnType<typeof vi.fn>;
const mockComputeFlagImpact = computeFlagImpact as ReturnType<typeof vi.fn>;
const mockGetFlagInventory = getFlagInventory as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecision(overrides: Partial<RouteDecision> & { route: RouteDecision["route"] }): RouteDecision {
  return {
    confidence: 0.9,
    extractedEntities: [],
    strippedQuery: "test query",
    ...overrides,
  };
}

function makeOptions(
  stores: { kvStore: InMemoryKVStore; graphStore: InMemoryGraphStore; searchStore: InMemorySearchStore },
  format: "table" | "json" | "sarif" = "table",
): QueryOptions {
  return {
    kvStore: stores.kvStore,
    graphStore: stores.graphStore,
    searchStore: stores.searchStore,
    verbose: false,
    format,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("queryCommand", () => {
  let kvStore: InMemoryKVStore;
  let graphStore: InMemoryGraphStore;
  let searchStore: InMemorySearchStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleSpy: { mock: { calls: any[][] } };

  beforeEach(() => {
    vi.clearAllMocks();
    kvStore = new InMemoryKVStore();
    graphStore = new InMemoryGraphStore();
    searchStore = new InMemorySearchStore();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  // -------------------------------------------------------------------------
  // structural: circular dependencies
  // -------------------------------------------------------------------------
  describe("structural route — circular dependencies", () => {
    it("displays circular dependencies in table format", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "structural", strippedQuery: "circular dependencies" }),
      );
      await kvStore.set("circularDeps:repo-a", JSON.stringify([["a.ts", "b.ts", "a.ts"]]));

      await queryCommand("circular dependencies", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("1 circular dependencies (repo-a)");
      expect(output).toContain("a.ts -> b.ts -> a.ts");
    });

    it("outputs circular deps as JSON", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "structural", strippedQuery: "circular dependencies" }),
      );
      await kvStore.set("circularDeps:repo-a", JSON.stringify([["x.ts", "y.ts", "x.ts"]]));

      await queryCommand("circular", makeOptions({ kvStore, graphStore, searchStore }, "json"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { route: string; cycles: unknown[] };
      expect(parsed.route).toBe("structural");
      expect(parsed.cycles).toHaveLength(1);
    });

    it("outputs circular deps as SARIF", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "structural", strippedQuery: "circular dependencies" }),
      );
      await kvStore.set("circularDeps:repo-a", JSON.stringify([["m.ts", "n.ts", "m.ts"]]));

      await queryCommand("circular", makeOptions({ kvStore, graphStore, searchStore }, "sarif"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { runs: Array<{ results: unknown[] }> };
      expect(parsed.runs[0]!.results).toHaveLength(1);
    });

    it("reports no circular deps when none exist", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "structural", strippedQuery: "circular dependencies" }),
      );

      await queryCommand("circular", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("No circular dependencies found");
    });

    it("filters circular deps by repo", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "structural", strippedQuery: "circular dependencies", repo: "repo-b" }),
      );
      await kvStore.set("circularDeps:repo-a", JSON.stringify([["a.ts", "b.ts", "a.ts"]]));
      await kvStore.set("circularDeps:repo-b", JSON.stringify([["x.ts", "y.ts", "x.ts"]]));

      await queryCommand("circular", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("repo-b");
      expect(output).not.toContain("repo-a");
    });
  });

  // -------------------------------------------------------------------------
  // structural: callers/callees/dependencies
  // -------------------------------------------------------------------------
  describe("structural route — entity queries", () => {
    it("executes callers query by default", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "structural", strippedQuery: "who calls handleRequest", extractedEntities: ["handleRequest"] }),
      );
      mockExecuteCallers.mockResolvedValue({
        description: "2 callers of handleRequest",
        edges: [{ source: "app.ts", target: "handleRequest", kind: "calls" }],
      });

      await queryCommand("who calls handleRequest", makeOptions({ kvStore, graphStore, searchStore }));

      expect(mockExecuteCallers).toHaveBeenCalledWith("handleRequest", graphStore, undefined, searchStore);
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("2 callers of handleRequest");
      expect(output).toContain("app.ts -> handleRequest [calls]");
    });

    it("executes callees query when 'callees' is in query", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "structural", strippedQuery: "callees of main", extractedEntities: ["main"] }),
      );
      mockExecuteCallees.mockResolvedValue({
        description: "1 callee of main",
        edges: [{ source: "main", target: "init", kind: "calls" }],
      });

      await queryCommand("callees of main", makeOptions({ kvStore, graphStore, searchStore }));

      expect(mockExecuteCallees).toHaveBeenCalled();
    });

    it("executes dependency query when 'depend' is in query", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "structural", strippedQuery: "dependencies of utils.ts", extractedEntities: ["utils.ts"] }),
      );
      mockExecuteDeps.mockResolvedValue({
        description: "3 dependencies",
        edges: [{ source: "utils.ts", target: "lodash", kind: "imports" }],
      });

      await queryCommand("dependencies of utils.ts", makeOptions({ kvStore, graphStore, searchStore }));

      expect(mockExecuteDeps).toHaveBeenCalled();
    });

    it("outputs entity query as JSON", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "structural", strippedQuery: "callers of foo", extractedEntities: ["foo"] }),
      );
      mockExecuteCallers.mockResolvedValue({
        description: "1 caller",
        edges: [{ source: "bar.ts", target: "foo", kind: "calls" }],
      });

      await queryCommand("callers of foo", makeOptions({ kvStore, graphStore, searchStore }, "json"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { entity: string; edges: unknown[] };
      expect(parsed.entity).toBe("foo");
      expect(parsed.edges).toHaveLength(1);
    });

    it("prints message when no entity found", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "structural", strippedQuery: "show graph", extractedEntities: [] }),
      );

      await queryCommand("show graph", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("No entity found");
    });
  });

  // -------------------------------------------------------------------------
  // search route
  // -------------------------------------------------------------------------
  describe("search route", () => {
    it("displays search results in table format", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "search", strippedQuery: "authentication" }),
      );
      mockExecuteSearch.mockResolvedValue({
        description: "2 results for authentication",
        results: [
          { id: "auth.ts#login", content: "handles user login", score: 0.95, metadata: { repo: "repo-a" } },
          { id: "auth.ts#logout", content: "handles logout", score: 0.80, metadata: { repo: "repo-a" } },
        ],
      });

      await queryCommand("authentication", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("2 results for authentication");
      expect(output).toContain("auth.ts#login");
      expect(output).toContain("0.95");
    });

    it("filters search results by repo", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "search", strippedQuery: "handler", repo: "repo-b" }),
      );
      mockExecuteSearch.mockResolvedValue({
        description: "2 results",
        results: [
          { id: "a.ts", content: "handler a", score: 0.9, metadata: { repo: "repo-a" } },
          { id: "b.ts", content: "handler b", score: 0.8, metadata: { repo: "repo-b" } },
        ],
      });

      await queryCommand("handler", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("b.ts");
      expect(output).not.toContain("a.ts");
    });

    it("outputs search results as JSON", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "search", strippedQuery: "test" }),
      );
      mockExecuteSearch.mockResolvedValue({
        description: "1 result",
        results: [{ id: "test.ts", content: "testing utils", score: 0.7, metadata: {} }],
      });

      await queryCommand("test", makeOptions({ kvStore, graphStore, searchStore }, "json"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { route: string; results: unknown[] };
      expect(parsed.route).toBe("search");
      expect(parsed.results).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // analytical route
  // -------------------------------------------------------------------------
  describe("analytical route", () => {
    const sarifLog = {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [{
        tool: { driver: { name: "mma", version: "0.1.0", rules: [] } },
        results: [
          { ruleId: "fault/unhandled-error", level: "warning", message: { text: "Unhandled error in handler" } },
          { ruleId: "config/dead-flag", level: "note", message: { text: "Dead feature flag: BETA_UI" } },
        ],
      }],
    };

    it("shows matching diagnostics for broad query", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "analytical", strippedQuery: "show all diagnostics" }),
      );
      await kvStore.set("sarif:latest", JSON.stringify(sarifLog));

      await queryCommand("show all diagnostics", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("2 matching diagnostics");
      expect(output).toContain("fault/unhandled-error");
      expect(output).toContain("config/dead-flag");
    });

    it("filters by level (warnings)", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "analytical", strippedQuery: "show warnings" }),
      );
      await kvStore.set("sarif:latest", JSON.stringify(sarifLog));

      await queryCommand("show warnings", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("1 matching diagnostics");
      expect(output).toContain("fault/unhandled-error");
      expect(output).not.toContain("config/dead-flag");
    });

    it("filters by rule category (faults)", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "analytical", strippedQuery: "show faults" }),
      );
      await kvStore.set("sarif:latest", JSON.stringify(sarifLog));

      await queryCommand("show faults", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("1 matching diagnostics");
      expect(output).toContain("fault/unhandled-error");
    });

    it("outputs as JSON", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "analytical", strippedQuery: "show all issues" }),
      );
      await kvStore.set("sarif:latest", JSON.stringify(sarifLog));

      await queryCommand("issues", makeOptions({ kvStore, graphStore, searchStore }, "json"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { route: string; total: number };
      expect(parsed.route).toBe("analytical");
      expect(parsed.total).toBe(2);
    });

    it("emits raw SARIF log in sarif format", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "analytical", strippedQuery: "diagnostics" }),
      );
      await kvStore.set("sarif:latest", JSON.stringify(sarifLog));

      await queryCommand("diagnostics", makeOptions({ kvStore, graphStore, searchStore }, "sarif"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { version: string; runs: unknown[] };
      expect(parsed.version).toBe("2.1.0");
    });

    it("reports no results when sarif:latest is missing", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "analytical", strippedQuery: "diagnostics" }),
      );

      await queryCommand("diagnostics", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("No analysis results available");
    });
  });

  // -------------------------------------------------------------------------
  // architecture route
  // -------------------------------------------------------------------------
  describe("architecture route", () => {
    it("displays architecture overview in table format", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "architecture", strippedQuery: "architecture overview" }),
      );
      mockExecuteArch.mockResolvedValue({
        description: "Architecture: 2 repos",
        repos: [
          { name: "repo-a", role: "library", importCount: 10, crossRepoImports: 2, callCount: 5, serviceCallCount: 0 },
        ],
        crossRepoEdges: [],
        serviceTopology: [],
      });

      await queryCommand("architecture", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Architecture: 2 repos");
      expect(output).toContain("repo-a [library]");
    });

    it("outputs architecture as JSON", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "architecture", strippedQuery: "architecture" }),
      );
      mockExecuteArch.mockResolvedValue({
        description: "overview",
        repos: [{ name: "r", role: "app", importCount: 1, crossRepoImports: 0, callCount: 0, serviceCallCount: 0 }],
        crossRepoEdges: [],
        serviceTopology: [],
      });

      await queryCommand("arch", makeOptions({ kvStore, graphStore, searchStore }, "json"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { route: string; repos: unknown[] };
      expect(parsed.route).toBe("architecture");
      expect(parsed.repos).toHaveLength(1);
    });

    it("shows cross-repo edges and service topology", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "architecture", strippedQuery: "architecture" }),
      );
      mockExecuteArch.mockResolvedValue({
        description: "Architecture overview",
        repos: [],
        crossRepoEdges: [{ sourceRepo: "api", targetPackage: "@shared/utils", count: 5 }],
        serviceTopology: [
          { protocol: "http", role: "producer", sourceRepo: "api", sourceFile: "routes.ts", target: "/users", detail: "GET" },
        ],
      });

      await queryCommand("architecture", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Cross-repo dependencies");
      expect(output).toContain("api -> @shared/utils");
      expect(output).toContain("Service topology");
      expect(output).toContain("http/producer");
    });
  });

  // -------------------------------------------------------------------------
  // pattern route
  // -------------------------------------------------------------------------
  describe("pattern route", () => {
    it("displays detected patterns", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "pattern", strippedQuery: "show patterns" }),
      );
      await kvStore.set("patterns:repo-a", JSON.stringify([
        { kind: "factory", name: "UserFactory", confidence: 0.85, locations: [{ module: "src/user.ts" }] },
        { kind: "singleton", name: "DbPool", confidence: 0.92, locations: [{ module: "src/db.ts" }] },
      ]));

      await queryCommand("show patterns", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("2 patterns (repo-a)");
      expect(output).toContain("[factory] UserFactory");
      expect(output).toContain("[singleton] DbPool");
    });

    it("filters patterns by kind", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "pattern", strippedQuery: "show factory patterns" }),
      );
      await kvStore.set("patterns:repo-a", JSON.stringify([
        { kind: "factory", name: "UserFactory", confidence: 0.85, locations: [{ module: "src/user.ts" }] },
        { kind: "singleton", name: "DbPool", confidence: 0.92, locations: [{ module: "src/db.ts" }] },
      ]));

      await queryCommand("show factory patterns", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("1 patterns");
      expect(output).toContain("UserFactory");
      expect(output).not.toContain("DbPool");
    });

    it("reports no patterns when none exist", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "pattern", strippedQuery: "patterns" }),
      );

      await queryCommand("patterns", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("No patterns found");
    });

    it("outputs patterns as JSON", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "pattern", strippedQuery: "patterns" }),
      );
      await kvStore.set("patterns:repo-a", JSON.stringify([
        { kind: "observer", name: "EventBus", confidence: 0.75, locations: [{ module: "src/events.ts" }] },
      ]));

      await queryCommand("patterns", makeOptions({ kvStore, graphStore, searchStore }, "json"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { route: string; patterns: unknown[] };
      expect(parsed.route).toBe("pattern");
      expect(parsed.patterns).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // documentation route
  // -------------------------------------------------------------------------
  describe("documentation route", () => {
    it("displays generated docs", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "documentation", strippedQuery: "show documentation" }),
      );
      await kvStore.set("docs:functional:repo-a", "# API Service\nHandles HTTP requests.");

      await queryCommand("show docs", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Documentation (repo-a)");
      expect(output).toContain("# API Service");
    });

    it("reports no docs when none exist", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "documentation", strippedQuery: "docs" }),
      );

      await queryCommand("docs", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("No documentation available");
    });

    it("outputs docs as JSON", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "documentation", strippedQuery: "documentation" }),
      );
      await kvStore.set("docs:functional:repo-a", "Service docs content");

      await queryCommand("docs", makeOptions({ kvStore, graphStore, searchStore }, "json"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { route: string; docs: Array<{ repo: string }> };
      expect(parsed.route).toBe("documentation");
      expect(parsed.docs).toHaveLength(1);
      expect(parsed.docs[0]!.repo).toBe("repo-a");
    });
  });

  // -------------------------------------------------------------------------
  // faulttree route
  // -------------------------------------------------------------------------
  describe("faulttree route", () => {
    it("displays fault trees", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "faulttree", strippedQuery: "show fault trees" }),
      );
      await kvStore.set("faultTrees:repo-a", JSON.stringify([
        { topEvent: { kind: "OR", label: "service crash", children: [{ kind: "BASIC", label: "OOM" }] } },
      ]));

      await queryCommand("fault trees", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("1 fault trees (repo-a)");
      expect(output).toContain("[OR] service crash (1 children)");
    });

    it("reports no fault trees when none exist", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "faulttree", strippedQuery: "fault trees" }),
      );

      await queryCommand("fault trees", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("No fault trees found");
    });

    it("outputs fault trees as JSON", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "faulttree", strippedQuery: "faults" }),
      );
      await kvStore.set("faultTrees:repo-a", JSON.stringify([
        { topEvent: { kind: "AND", label: "data loss", children: [] } },
      ]));

      await queryCommand("faults", makeOptions({ kvStore, graphStore, searchStore }, "json"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { route: string; trees: unknown[] };
      expect(parsed.route).toBe("faulttree");
      expect(parsed.trees).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // flagimpact route
  // -------------------------------------------------------------------------
  describe("flagimpact route", () => {
    const impactResult = {
      flagName: "ENABLE_DARK_MODE",
      repo: "repo-a",
      maxDepth: 2,
      totalAffected: 3,
      flagLocations: ["src/config.ts"],
      affectedFiles: [
        { path: "src/theme.ts", via: "import", depth: 1 },
        { path: "src/app.ts", via: "call", depth: 2 },
      ],
      affectedServices: [
        { endpoint: "/api/theme", sourceFile: "src/theme.ts" },
      ],
    };

    const inventoryResult = {
      total: 2,
      returned: 2,
      offset: 0,
      hasMore: false,
      flags: [
        { name: "ENABLE_DARK_MODE", repo: "repo-a", sdk: "launchdarkly", locationCount: 3, modules: ["src/config.ts", "src/theme.ts"] },
        { name: "BETA_FEATURE", repo: "repo-a", sdk: undefined, locationCount: 1, modules: ["src/beta.ts"] },
      ],
    };

    // --- impact path (entity + repo) ---

    it("displays flag impact in table format", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "flagimpact", strippedQuery: "flag impact of ENABLE_DARK_MODE", extractedEntities: ["ENABLE_DARK_MODE"], repo: "repo-a" }),
      );
      mockComputeFlagImpact.mockResolvedValue(impactResult);

      await queryCommand("flag impact of ENABLE_DARK_MODE", makeOptions({ kvStore, graphStore, searchStore }));

      expect(mockComputeFlagImpact).toHaveBeenCalledWith("ENABLE_DARK_MODE", "repo-a", kvStore, graphStore);
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("ENABLE_DARK_MODE");
      expect(output).toContain("src/theme.ts");
      expect(output).toContain("/api/theme");
    });

    it("outputs flag impact as JSON", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "flagimpact", extractedEntities: ["ENABLE_DARK_MODE"], repo: "repo-a" }),
      );
      mockComputeFlagImpact.mockResolvedValue(impactResult);

      await queryCommand("flag impact", makeOptions({ kvStore, graphStore, searchStore }, "json"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { route: string; flagName: string };
      expect(parsed.route).toBe("flagimpact");
      expect(parsed.flagName).toBe("ENABLE_DARK_MODE");
    });

    it("outputs flag impact as SARIF", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "flagimpact", extractedEntities: ["ENABLE_DARK_MODE"], repo: "repo-a" }),
      );
      mockComputeFlagImpact.mockResolvedValue(impactResult);

      await queryCommand("flag impact", makeOptions({ kvStore, graphStore, searchStore }, "sarif"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { runs: Array<{ results: Array<{ ruleId: string }> }> };
      expect(parsed.runs[0]!.results.length).toBe(2);
      expect(parsed.runs[0]!.results[0]!.ruleId).toBe("flagimpact/impact");
    });

    // --- inventory path (no entity or no repo) ---

    it("displays flag inventory in table format", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "flagimpact", strippedQuery: "feature flags", extractedEntities: [] }),
      );
      mockGetFlagInventory.mockResolvedValue(inventoryResult);

      await queryCommand("feature flags", makeOptions({ kvStore, graphStore, searchStore }));

      expect(mockGetFlagInventory).toHaveBeenCalledWith(kvStore, { repo: undefined, search: undefined });
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("2 feature flags found");
      expect(output).toContain("ENABLE_DARK_MODE");
      expect(output).toContain("BETA_FEATURE");
    });

    it("reports no flags when inventory is empty", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "flagimpact", strippedQuery: "flags", extractedEntities: [] }),
      );
      mockGetFlagInventory.mockResolvedValue({ total: 0, returned: 0, offset: 0, hasMore: false, flags: [] });

      await queryCommand("flags", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("No feature flags found");
    });

    it("outputs inventory as JSON", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "flagimpact", extractedEntities: [] }),
      );
      mockGetFlagInventory.mockResolvedValue(inventoryResult);

      await queryCommand("flags", makeOptions({ kvStore, graphStore, searchStore }, "json"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { route: string; total: number; flags: unknown[] };
      expect(parsed.route).toBe("flagimpact");
      expect(parsed.total).toBe(2);
    });

    it("outputs inventory as SARIF", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "flagimpact", extractedEntities: [] }),
      );
      mockGetFlagInventory.mockResolvedValue(inventoryResult);

      await queryCommand("flags", makeOptions({ kvStore, graphStore, searchStore }, "sarif"));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output) as { runs: Array<{ results: Array<{ ruleId: string }> }> };
      expect(parsed.runs[0]!.results.length).toBe(2);
      expect(parsed.runs[0]!.results[0]!.ruleId).toBe("flagimpact/inventory");
    });

    it("shows hasMore indicator when inventory is truncated", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "flagimpact", extractedEntities: [] }),
      );
      mockGetFlagInventory.mockResolvedValue({ ...inventoryResult, hasMore: true });

      await queryCommand("flags", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("and more");
    });
  });

  // -------------------------------------------------------------------------
  // synthesis route (narration lookup)
  // -------------------------------------------------------------------------
  describe("synthesis route", () => {
    it("prints fallback message when no narrations cached", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "synthesis", strippedQuery: "summarize the codebase" }),
      );

      await queryCommand("summarize", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("No narrations found");
    });

    it("returns cached narrations when available", async () => {
      mockRouteQuery.mockReturnValue(
        makeDecision({ route: "synthesis", strippedQuery: "architecture" }),
      );

      await kvStore.set("narration:repo-arch:my-repo", "This repo uses a layered architecture.");

      await queryCommand("architecture", makeOptions({ kvStore, graphStore, searchStore }));

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("layered architecture");
    });
  });
});
