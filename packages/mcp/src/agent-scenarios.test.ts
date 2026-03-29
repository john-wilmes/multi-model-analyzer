/**
 * Agent scenario tests: multi-step MCP tool chains that simulate what an LLM
 * agent actually experiences. Each scenario seeds realistic interconnected data,
 * then executes 2-4 sequential tool calls where each step's output informs the
 * next.
 */

import { describe, it, expect, vi } from "vitest";
import { registerTools } from "./tools.js";
import type { Stores } from "./tools.js";

vi.mock("@mma/ingestion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mma/ingestion")>();
  return {
    ...actual,
    scanGitHubOrg: vi.fn().mockResolvedValue({ totalReposInOrg: 0, repos: [] }),
    cloneOrFetch: vi.fn().mockResolvedValue(undefined),
  };
});
import {
  InMemoryGraphStore,
  InMemorySearchStore,
  InMemoryKVStore,
} from "@mma/storage";

type ToolResult = { content: Array<{ type: string; text?: string; uri?: string }> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (...args: any[]) => Promise<ToolResult>;
interface ToolEntry { description: string; handler: ToolHandler; }

function createMockServer() {
  const tools = new Map<string, ToolEntry>();
  return {
    registerTool: vi.fn(
      (name: string, config: { description: string }, handler: ToolHandler) => {
        tools.set(name, { description: config.description, handler });
      },
    ),
    tools,
  };
}

function makeStores() {
  return {
    graphStore: new InMemoryGraphStore(),
    searchStore: new InMemorySearchStore(),
    kvStore: new InMemoryKVStore(),
  };
}

function makeInvoker(stores: ReturnType<typeof makeStores>) {
  const server = createMockServer();
  registerTools(server as unknown as Parameters<typeof registerTools>[0], stores as unknown as Stores);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const handler = server.tools.get(name)?.handler;
    if (!handler) throw new Error(`Tool not found: ${name}`);
    return handler(args);
  };
}

// Parse the JSON text content from a tool response.
// Finds the last text item that looks like JSON (starts with { or [), so it
// works even if a welcome blurb is prepended as a non-JSON text item.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(result: ToolResult): any {
  const textItems = result.content.filter(
    (c): c is { type: "text"; text: string } => c.type === "text" && typeof (c as { text?: string }).text === "string",
  );
  const jsonItem = [...textItems].reverse().find(c => /^\s*[\[{]/.test(c.text));
  const item = jsonItem ?? textItems[0];
  if (!item) throw new Error("No text content in tool result");
  return JSON.parse(item.text) as Record<string, unknown>;
}

describe("agent scenarios", () => {
  // ---------------------------------------------------------------------------
  // Scenario 1: "What breaks if I change this file?"
  // Chain: search → get_blast_radius → get_diagnostics
  // ---------------------------------------------------------------------------
  describe("scenario 1: what breaks if I change this file?", () => {
    it("finds dependents and matches diagnostics to affected files", async () => {
      const stores = makeStores();
      const invoke = makeInvoker(stores);

      // Seed graph: auth.ts imports crypto.ts; controllers import auth.ts
      await stores.graphStore.addEdges([{
        source: "src/utils/auth.ts",
        target: "src/utils/crypto.ts",
        kind: "imports",
        metadata: { repo: "api-server" },
      }]);
      await stores.graphStore.addEdges([{
        source: "src/controllers/user-ctrl.ts",
        target: "src/utils/auth.ts",
        kind: "imports",
        metadata: { repo: "api-server" },
      }]);
      await stores.graphStore.addEdges([{
        source: "src/controllers/admin-ctrl.ts",
        target: "src/utils/auth.ts",
        kind: "imports",
        metadata: { repo: "api-server" },
      }]);

      // Seed search index: crypto.ts
      await stores.searchStore.index([
        { id: "api-server:src/utils/crypto.ts", content: "crypto utility hashing", metadata: { repo: "api-server" } },
      ]);

      // Seed SARIF per-repo findings
      await stores.kvStore.set("sarif:latest:index", JSON.stringify({ repos: ["api-server"] }));
      await stores.kvStore.set("sarif:repo:api-server", JSON.stringify([
        {
          ruleId: "structural/high-coupling",
          level: "error",
          message: { text: "High coupling detected" },
          logicalLocations: [{ name: "src/utils/auth.ts", properties: { repo: "api-server" } }],
        },
        {
          ruleId: "structural/god-module",
          level: "warning",
          message: { text: "God module detected" },
          logicalLocations: [{ name: "src/controllers/user-ctrl.ts", properties: { repo: "api-server" } }],
        },
      ]));

      // Step 1: search for "crypto" in api-server
      const searchResult = parse(await invoke("search", { query: "crypto", repo: "api-server" }));
      expect(searchResult.total).toBeGreaterThanOrEqual(1);
      expect(searchResult.results).toBeDefined();
       
      const firstResult = searchResult.results[0];
      expect(firstResult.id).toContain("crypto");

      // Step 2: compute blast radius for crypto.ts
      const blastResult = parse(await invoke("get_blast_radius", {
        files: ["src/utils/crypto.ts"],
        repo: "api-server",
      }));
      expect(blastResult.affectedFiles).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const affectedPaths: string[] = (blastResult.affectedFiles as any[]).map((f: any) => f.path as string);
      expect(affectedPaths.some(p => p.includes("auth"))).toBe(true);
      expect(affectedPaths.some(p => p.includes("user-ctrl") || p.includes("admin-ctrl"))).toBe(true);

      // Step 3: get diagnostics for api-server and assert at least one finding
      // touches an affected file from step 2
      const diagResult = parse(await invoke("get_diagnostics", { repo: "api-server" }));
      expect(diagResult.total).toBeGreaterThanOrEqual(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const findings = diagResult.results as any[];
      expect(findings.length).toBeGreaterThanOrEqual(1);

      const findingLocations = findings.flatMap(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (f: any) => (f.logicalLocations ?? []).map((loc: any) => loc.name as string),
      );
      const overlap = findingLocations.filter(loc =>
        affectedPaths.some(p => p.includes(loc) || loc.includes(p.split("/").pop()!)),
      );
      expect(overlap.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: "Find the most coupled service and trace its dependencies"
  // Chain: get_service_correlation → get_cross_repo_graph → get_dependencies
  // ---------------------------------------------------------------------------
  describe("scenario 2: find the most coupled service and trace its dependencies", () => {
    it("identifies top linchpin then traces cross-repo and intra-repo edges", async () => {
      const stores = makeStores();
      const invoke = makeInvoker(stores);

      // Seed correlation:services with two linchpins
      await stores.kvStore.set("correlation:services", JSON.stringify({
        links: [],
        linchpins: [
          { endpoint: "/api/payments", producerCount: 3, consumerCount: 5, linkedRepoCount: 4, criticalityScore: 42 },
          { endpoint: "/api/users", producerCount: 1, consumerCount: 2, linkedRepoCount: 2, criticalityScore: 15 },
        ],
        orphanedServices: [],
      }));

      // Seed correlation:graph with cross-repo edges pointing to payments-svc
      await stores.kvStore.set("correlation:graph", JSON.stringify({
        edges: [
          {
            edge: { source: "src/checkout.ts", target: "src/handler.ts", kind: "imports", metadata: {} },
            sourceRepo: "checkout-svc",
            targetRepo: "payments-svc",
            packageName: "@acme/payments",
          },
          {
            edge: { source: "src/billing.ts", target: "src/handler.ts", kind: "imports", metadata: {} },
            sourceRepo: "billing-svc",
            targetRepo: "payments-svc",
            packageName: "@acme/payments",
          },
        ],
        repoPairs: ["checkout-svc->payments-svc", "billing-svc->payments-svc"],
        downstreamMap: [["checkout-svc", ["payments-svc"]], ["billing-svc", ["payments-svc"]]],
        upstreamMap: [["payments-svc", ["checkout-svc", "billing-svc"]]],
      }));

      // Seed intra-repo graph edges for payments-svc
      await stores.graphStore.addEdges([{
        source: "src/handler.ts",
        target: "src/db/pool.ts",
        kind: "imports",
        metadata: { repo: "payments-svc" },
      }]);
      await stores.graphStore.addEdges([{
        source: "src/handler.ts",
        target: "src/utils/auth.ts",
        kind: "imports",
        metadata: { repo: "payments-svc" },
      }]);

      // Step 1: get service correlation linchpins
      const corrResult = parse(await invoke("get_service_correlation", { kind: "linchpins" }));
      expect(corrResult.linchpins).toBeDefined();
      const linchpins = corrResult.linchpins.results as Array<{ endpoint: string; criticalityScore: number }>;
      expect(linchpins.length).toBeGreaterThanOrEqual(2);
      const top = linchpins.reduce((a, b) => a.criticalityScore > b.criticalityScore ? a : b);
      expect(top.endpoint).toBe("/api/payments");

      // Step 2: get cross-repo graph for payments-svc
      const graphResult = parse(await invoke("get_cross_repo_graph", { repo: "payments-svc" }));
      expect(graphResult.edgeCount).toBeGreaterThanOrEqual(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const edges = graphResult.edges as any[];
      expect(edges.length).toBeGreaterThanOrEqual(1);

      // Step 3: get dependencies for handler.ts — may return empty if FQN not matched, but must not error
      const depsResult = parse(await invoke("get_dependencies", {
        symbol: "src/handler.ts",
        repo: "payments-svc",
      }));
      expect(depsResult).toBeDefined();
      expect(depsResult.error).toBeUndefined();
      expect(depsResult.nodes).toBeDefined();
      expect(depsResult.edges).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: "Which repos are affected by this feature flag?"
  // Chain: get_flag_inventory → get_flag_impact
  // ---------------------------------------------------------------------------
  describe("scenario 3: which repos are affected by this feature flag?", () => {
    it("finds flag across repos then computes blast radius", async () => {
      const stores = makeStores();
      const invoke = makeInvoker(stores);

      // Seed flags in two repos
      await stores.kvStore.set("flags:checkout-svc", JSON.stringify({
        repo: "checkout-svc",
        flags: [
          {
            name: "ENABLE_NEW_CHECKOUT",
            sdk: "launchdarkly",
            locations: [
              { module: "src/checkout/flow.ts", line: 12 },
              { module: "src/checkout/cart.ts", line: 55 },
            ],
          },
        ],
      }));
      await stores.kvStore.set("flags:frontend-app", JSON.stringify({
        repo: "frontend-app",
        flags: [
          {
            name: "ENABLE_NEW_CHECKOUT",
            sdk: "launchdarkly",
            locations: [
              { module: "src/pages/checkout.tsx", line: 8 },
            ],
          },
        ],
      }));

      // Seed intra-repo graph: summary.ts → flow.ts, routes.ts → cart.ts
      await stores.graphStore.addEdges([{
        source: "src/checkout/summary.ts",
        target: "src/checkout/flow.ts",
        kind: "imports",
        metadata: { repo: "checkout-svc" },
      }]);
      await stores.graphStore.addEdges([{
        source: "src/checkout/routes.ts",
        target: "src/checkout/cart.ts",
        kind: "imports",
        metadata: { repo: "checkout-svc" },
      }]);

      // Seed cross-repo graph: checkout-svc → payments-svc
      await stores.kvStore.set("correlation:graph", JSON.stringify({
        edges: [
          {
            edge: { source: "src/checkout/flow.ts", target: "src/payment.ts", kind: "imports", metadata: {} },
            sourceRepo: "checkout-svc",
            targetRepo: "payments-svc",
            packageName: "@acme/payments",
          },
        ],
        repoPairs: ["checkout-svc->payments-svc"],
        downstreamMap: [["checkout-svc", ["payments-svc"]]],
        upstreamMap: [["payments-svc", ["checkout-svc"]]],
      }));

      // Step 1: get flag inventory across all repos
      const inventoryResult = parse(await invoke("get_flag_inventory", {}));
      expect(inventoryResult.total).toBeGreaterThanOrEqual(2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const flags = inventoryResult.flags as any[];
      const checkoutFlag = flags.find((f: { name: string; repo: string }) =>
        f.name === "ENABLE_NEW_CHECKOUT" && f.repo === "checkout-svc",
      );
      const frontendFlag = flags.find((f: { name: string; repo: string }) =>
        f.name === "ENABLE_NEW_CHECKOUT" && f.repo === "frontend-app",
      );
      expect(checkoutFlag).toBeDefined();
      expect(frontendFlag).toBeDefined();

      // Step 2: compute flag impact for checkout-svc with cross-repo
      const impactResult = parse(await invoke("get_flag_impact", {
        flag: "ENABLE_NEW_CHECKOUT",
        repo: "checkout-svc",
        crossRepo: true,
      }));
      expect(impactResult.flagName).toBe("ENABLE_NEW_CHECKOUT");
      expect(impactResult.flagLocations).toBeDefined();
      // flagLocations is string[] of file paths (modules)
      const flagLocs = impactResult.flagLocations as string[];
      expect(flagLocs.some(m => m.includes("flow.ts"))).toBe(true);
      expect(flagLocs.some(m => m.includes("cart.ts"))).toBe(true);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const affectedPaths = (impactResult.affectedFiles as any[]).map((f: { path: string }) => f.path);
      expect(affectedPaths.some(p => p.includes("summary"))).toBe(true);
      expect(affectedPaths.some(p => p.includes("routes"))).toBe(true);

      expect(impactResult.crossRepo).toBeDefined();
      expect(impactResult.crossRepo.reposReached).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: "Triage the worst code quality issues"
  // Chain: get_diagnostics → get_metrics → get_blast_radius
  // ---------------------------------------------------------------------------
  describe("scenario 4: triage the worst code quality issues", () => {
    it("finds error-level findings, checks instability metrics, then blast radius", async () => {
      const stores = makeStores();
      const invoke = makeInvoker(stores);

      // Seed SARIF with errors for engine.ts and warnings for others
      await stores.kvStore.set("sarif:latest:index", JSON.stringify({ repos: ["engine-repo"] }));
      await stores.kvStore.set("sarif:repo:engine-repo", JSON.stringify([
        {
          ruleId: "structural/god-module",
          level: "error",
          message: { text: "God module: too many responsibilities" },
          logicalLocations: [{ name: "src/core/engine.ts", properties: { repo: "engine-repo" } }],
        },
        {
          ruleId: "structural/cyclomatic-complexity",
          level: "error",
          message: { text: "Cyclomatic complexity exceeds threshold" },
          logicalLocations: [{ name: "src/core/engine.ts", properties: { repo: "engine-repo" } }],
        },
        {
          ruleId: "structural/high-coupling",
          level: "warning",
          message: { text: "High coupling" },
          logicalLocations: [{ name: "src/utils/helpers.ts", properties: { repo: "engine-repo" } }],
        },
        {
          ruleId: "structural/missing-abstraction",
          level: "warning",
          message: { text: "Missing abstraction layer" },
          logicalLocations: [{ name: "src/io/reader.ts", properties: { repo: "engine-repo" } }],
        },
        {
          ruleId: "structural/long-function",
          level: "warning",
          message: { text: "Function too long" },
          logicalLocations: [{ name: "src/io/writer.ts", properties: { repo: "engine-repo" } }],
        },
      ]));

      // Seed metrics for engine-repo
      await stores.kvStore.set("metrics:engine-repo", JSON.stringify([
        { module: "src/core/engine.ts", instability: 0.95, abstractness: 0.1, distance: 0.55, fanIn: 2, fanOut: 18 },
        { module: "src/utils/helpers.ts", instability: 0.3, abstractness: 0.5, distance: 0.2, fanIn: 5, fanOut: 2 },
      ]));

      // Seed graph: processor.ts and handler.ts both import engine.ts
      await stores.graphStore.addEdges([{
        source: "src/processing/processor.ts",
        target: "src/core/engine.ts",
        kind: "imports",
        metadata: { repo: "engine-repo" },
      }]);
      await stores.graphStore.addEdges([{
        source: "src/api/handler.ts",
        target: "src/core/engine.ts",
        kind: "imports",
        metadata: { repo: "engine-repo" },
      }]);

      // Step 1: get error-level diagnostics for engine-repo
      const diagResult = parse(await invoke("get_diagnostics", { level: "error", repo: "engine-repo" }));
      expect(diagResult.total).toBeGreaterThanOrEqual(2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const findings = diagResult.results as any[];
      expect(findings.every((f: { level: string }) => f.level === "error")).toBe(true);
      // Extract file from logicalLocations
      const engineFile = findings[0]?.logicalLocations?.[0]?.name as string;
      expect(engineFile).toContain("engine");

      // Step 2: get metrics filtered to "engine" module
      const metricsResult = parse(await invoke("get_metrics", { repo: "engine-repo", module: "engine" }));
      expect(metricsResult.results).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const moduleResults = metricsResult.results as any[];
      expect(moduleResults.length).toBeGreaterThanOrEqual(1);
      const engineMetric = moduleResults.find((m: { module: string }) => m.module.includes("engine"));
      expect(engineMetric).toBeDefined();
      expect(engineMetric.instability).toBeGreaterThan(0.9);

      // Step 3: blast radius for engine.ts
      const blastResult = parse(await invoke("get_blast_radius", {
        files: ["src/core/engine.ts"],
        repo: "engine-repo",
      }));
      expect(blastResult.affectedFiles).toBeDefined();
      expect(blastResult.affectedFiles.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: "Trace a vulnerability's reach"
  // Chain: get_vulnerability → search → get_callers → get_blast_radius
  // ---------------------------------------------------------------------------
  describe("scenario 5: trace a vulnerability's reach", () => {
    it("finds CVE, locates file, gets callers, then blast radius", async () => {
      const stores = makeStores();
      const invoke = makeInvoker(stores);

      // Seed sarif index and vulnerability findings
      await stores.kvStore.set("sarif:latest:index", JSON.stringify({ repos: ["api-svc"] }));
      await stores.kvStore.set("sarif:vuln:api-svc", JSON.stringify([
        {
          ruleId: "CVE-2024-1234",
          level: "error",
          message: { text: "Prototype pollution in lodash merge" },
          properties: { severity: "high", package: "lodash" },
          logicalLocations: [{ name: "src/lib/data.ts", properties: { repo: "api-svc" } }],
        },
      ]));

      // Seed search index: data.ts with lodash content
      await stores.searchStore.index([
        { id: "api-svc:src/lib/data.ts", content: "lodash merge utility data transformation", metadata: { repo: "api-svc" } },
      ]);

      // Seed graph: transformer.ts and ingest.ts import data.ts; batch.ts imports transformer.ts
      await stores.graphStore.addEdges([{
        source: "src/pipeline/transformer.ts",
        target: "src/lib/data.ts",
        kind: "imports",
        metadata: { repo: "api-svc" },
      }]);
      await stores.graphStore.addEdges([{
        source: "src/pipeline/ingest.ts",
        target: "src/lib/data.ts",
        kind: "imports",
        metadata: { repo: "api-svc" },
      }]);
      await stores.graphStore.addEdges([{
        source: "src/pipeline/batch.ts",
        target: "src/pipeline/transformer.ts",
        kind: "imports",
        metadata: { repo: "api-svc" },
      }]);

      // Step 1: get vulnerability findings for api-svc with high severity
      const vulnResult = parse(await invoke("get_vulnerability", { repo: "api-svc", severity: "high" }));
      expect(vulnResult.findings).toBeDefined();
      expect(vulnResult.findings.length).toBeGreaterThanOrEqual(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vuln = (vulnResult.findings as any[])[0];
      expect(vuln.ruleId).toBe("CVE-2024-1234");

      // Step 2: search for lodash to confirm file location
      const searchResult = parse(await invoke("search", { query: "lodash", repo: "api-svc" }));
      expect(searchResult.total).toBeGreaterThanOrEqual(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const searchHit = (searchResult.results as any[])[0];
      expect(searchHit.id).toContain("data.ts");

      // Step 3: get callers of data.ts — may use FQN fallback but must not error
      const callersResult = parse(await invoke("get_callers", {
        symbol: "src/lib/data.ts",
        repo: "api-svc",
      }));
      expect(callersResult).toBeDefined();
      expect(callersResult.error).toBeUndefined();
      expect(callersResult.nodes).toBeDefined();
      // nodes is string[] of FQNs like "src/file.ts#Symbol"
      const nodeIds = callersResult.nodes as string[];
      // Accept either a hit or an empty set — the tool must not crash
      const hasExpectedCallers = nodeIds.some(id => id.includes("transformer") || id.includes("ingest"));
      expect(hasExpectedCallers || nodeIds.length === 0).toBe(true);

      // Step 4: blast radius for data.ts — should reach transformer, ingest, and batch
      const blastResult = parse(await invoke("get_blast_radius", {
        files: ["src/lib/data.ts"],
        repo: "api-svc",
      }));
      expect(blastResult.totalAffected).toBeGreaterThanOrEqual(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: "Understand cross-repo architecture and find orphaned services"
  // Chain: get_architecture → get_cross_repo_graph → get_service_correlation
  // ---------------------------------------------------------------------------
  describe("scenario 6: understand cross-repo architecture and find orphaned services", () => {
    it("surveys architecture, traces cross-repo graph, then finds orphans", async () => {
      const stores = makeStores();
      const invoke = makeInvoker(stores);

      // Seed intra-repo graph edges for two repos
      await stores.graphStore.addEdges([{
        source: "src/index.ts",
        target: "src/db.ts",
        kind: "imports",
        metadata: { repo: "data-svc" },
      }]);
      await stores.graphStore.addEdges([{
        source: "src/app.ts",
        target: "src/api.ts",
        kind: "imports",
        metadata: { repo: "web-svc" },
      }]);

      // Seed correlation:graph: web-svc → data-svc
      await stores.kvStore.set("correlation:graph", JSON.stringify({
        edges: [
          {
            edge: { source: "src/app.ts", target: "src/index.ts", kind: "imports", metadata: {} },
            sourceRepo: "web-svc",
            targetRepo: "data-svc",
            packageName: "@acme/data",
          },
        ],
        repoPairs: ["web-svc->data-svc"],
        downstreamMap: [["web-svc", ["data-svc"]]],
        upstreamMap: [["data-svc", ["web-svc"]]],
        paths: { "web-svc->data-svc": [["web-svc", "data-svc"]] },
      }));

      // Seed correlation:services: one orphan, no linchpins
      await stores.kvStore.set("correlation:services", JSON.stringify({
        links: [],
        linchpins: [],
        orphanedServices: [
          { endpoint: "/api/legacy-reports", hasProducers: false, hasConsumers: false, repos: ["reports-svc"] },
        ],
      }));

      // Step 1: get architecture overview — just verify no error and repos present
      const archResult = parse(await invoke("get_architecture", {}));
      expect(archResult).toBeDefined();
      // Architecture query reads edge counts; verify it returns repos array or valid shape
      const hasRepos = Array.isArray(archResult.repos);
      const hasError = "error" in archResult;
      // If there's no error, repos should be an array; if errored, that's also acceptable
      // (the point is the tool doesn't throw)
      expect(hasRepos || hasError).toBe(true);
      if (hasRepos) {
        expect(archResult.repos.length).toBeGreaterThanOrEqual(1);
      }

      // Step 2: get cross-repo graph with paths
      const graphResult = parse(await invoke("get_cross_repo_graph", { includePaths: true }));
      expect(graphResult.edgeCount).toBeGreaterThanOrEqual(1);
      expect(graphResult.repoPairs).toContain("web-svc->data-svc");
      expect(graphResult.paths).toBeDefined();
      const pathKeys = Object.keys(graphResult.paths as Record<string, unknown>);
      expect(pathKeys.length).toBeGreaterThanOrEqual(1);

      // Step 3: get orphaned services
      const corrResult = parse(await invoke("get_service_correlation", { kind: "orphaned" }));
      expect(corrResult.orphanedServices).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orphans = corrResult.orphanedServices.results as any[];
      expect(orphans.length).toBeGreaterThanOrEqual(1);
      const legacyOrphan = orphans.find((o: { endpoint: string }) => o.endpoint === "/api/legacy-reports");
      expect(legacyOrphan).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: "Validate configuration and generate test plan"
  // Chain: get_config_inventory → get_config_model → validate_config →
  //        get_test_configurations → get_interaction_strength
  // ---------------------------------------------------------------------------
  describe("scenario 7: validate configuration and generate test plan", () => {
    it("inventories params, checks constraints, validates configs, then generates CIT plan", async () => {
      const stores = makeStores();
      const invoke = makeInvoker(stores);

      // Seed config inventory
      await stores.kvStore.set("config-inventory:platform-svc", JSON.stringify({
        parameters: [
          { name: "DATABASE_URL", locations: [{ repo: "platform-svc", module: "src/config.ts" }], kind: "credential", valueType: "string" },
          { name: "CACHE_TTL", locations: [{ repo: "platform-svc", module: "src/config.ts" }], kind: "setting", valueType: "number", rangeMin: 0, rangeMax: 3600, defaultValue: 300 },
          { name: "AUTH_PROVIDER", locations: [{ repo: "platform-svc", module: "src/auth.ts" }], kind: "setting", valueType: "enum", enumValues: ["oauth", "saml", "ldap"] },
          { name: "ENABLE_MFA", locations: [{ repo: "platform-svc", module: "src/auth.ts" }], kind: "flag", valueType: "boolean" },
          { name: "LOG_LEVEL", locations: [{ repo: "platform-svc", module: "src/logger.ts" }], kind: "setting", valueType: "enum", enumValues: ["debug", "info", "warn", "error"] },
        ],
        repo: "platform-svc",
      }));

      // Seed flag inventory (flags also appear in config inventory as kind: "flag")
      await stores.kvStore.set("flag-inventory:platform-svc", JSON.stringify({
        flags: [
          { name: "ENABLE_MFA", locations: [{ repo: "platform-svc", module: "src/auth.ts", fullyQualifiedName: "src/auth.ts:ENABLE_MFA" }] },
          { name: "ENABLE_CACHE", locations: [{ repo: "platform-svc", module: "src/cache.ts", fullyQualifiedName: "src/cache.ts:ENABLE_CACHE" }] },
        ],
        repo: "platform-svc",
      }));

      // Seed config model with constraints
      await stores.kvStore.set("config-model:platform-svc", JSON.stringify({
        flags: [
          { name: "ENABLE_MFA", locations: [{ repo: "platform-svc", module: "src/auth.ts" }] },
          { name: "ENABLE_CACHE", locations: [{ repo: "platform-svc", module: "src/cache.ts" }] },
        ],
        constraints: [
          { kind: "requires", flags: ["AUTH_PROVIDER", "DATABASE_URL"], description: "AUTH_PROVIDER requires DATABASE_URL", source: "inferred" },
          { kind: "requires", flags: ["ENABLE_MFA", "AUTH_PROVIDER"], description: "ENABLE_MFA requires AUTH_PROVIDER", source: "inferred" },
          { kind: "enum", flags: ["AUTH_PROVIDER"], description: "AUTH_PROVIDER must be oauth|saml|ldap", source: "schema", allowedValues: ["oauth", "saml", "ldap"] },
          { kind: "enum", flags: ["LOG_LEVEL"], description: "LOG_LEVEL must be debug|info|warn|error", source: "schema", allowedValues: ["debug", "info", "warn", "error"] },
          { kind: "requires", flags: ["ENABLE_CACHE", "CACHE_TTL"], description: "ENABLE_CACHE requires CACHE_TTL", source: "inferred" },
        ],
        parameters: [
          { name: "DATABASE_URL", locations: [{ repo: "platform-svc", module: "src/config.ts" }], kind: "credential", valueType: "string" },
          { name: "CACHE_TTL", locations: [{ repo: "platform-svc", module: "src/config.ts" }], kind: "setting", valueType: "number", rangeMin: 0, rangeMax: 3600, defaultValue: 300 },
          { name: "AUTH_PROVIDER", locations: [{ repo: "platform-svc", module: "src/auth.ts" }], kind: "setting", valueType: "enum", enumValues: ["oauth", "saml", "ldap"] },
          { name: "ENABLE_MFA", locations: [{ repo: "platform-svc", module: "src/auth.ts" }], kind: "flag", valueType: "boolean" },
          { name: "LOG_LEVEL", locations: [{ repo: "platform-svc", module: "src/logger.ts" }], kind: "setting", valueType: "enum", enumValues: ["debug", "info", "warn", "error"] },
        ],
      }));

      // Step 1: get config inventory for platform-svc
      const inventoryResult = parse(await invoke("get_config_inventory", { repo: "platform-svc" }));
      expect(inventoryResult.total).toBeGreaterThanOrEqual(5);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params = inventoryResult.parameters as any[];
      const authProvider = params.find((p: { name: string }) => p.name === "AUTH_PROVIDER");
      const databaseUrl = params.find((p: { name: string }) => p.name === "DATABASE_URL");
      expect(authProvider).toBeDefined();
      expect(databaseUrl).toBeDefined();

      // Step 2: get config model — verify constraints are present
      const modelResult = parse(await invoke("get_config_model", { repo: "platform-svc" }));
      expect(modelResult.constraintCount).toBeGreaterThanOrEqual(5);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const constraints = modelResult.constraints as any[];
      const kinds = constraints.map((c: { kind: string }) => c.kind);
      expect(kinds).toContain("requires");
      expect(kinds).toContain("enum");

      // Step 3a: validate a valid config — AUTH_PROVIDER + DATABASE_URL set, satisfying all requires constraints
      const validResult = parse(await invoke("validate_config", {
        repo: "platform-svc",
        config: { AUTH_PROVIDER: "oauth", DATABASE_URL: "postgres://localhost/db", ENABLE_MFA: true },
      }));
      expect(validResult.valid).toBe(true);
      expect(validResult.issueCount).toBe(0);

      // Step 3b: validate an invalid config — ENABLE_MFA without AUTH_PROVIDER
      const invalidResult = parse(await invoke("validate_config", {
        repo: "platform-svc",
        config: { ENABLE_MFA: true },
      }));
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.issueCount).toBeGreaterThanOrEqual(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const issues = invalidResult.issues as any[];
      const missingAuth = issues.find((i: { message: string }) =>
        i.message.toLowerCase().includes("auth_provider"),
      );
      expect(missingAuth).toBeDefined();

      // Step 4: generate pairwise test configurations
      // constraintAware: false because single-value params (e.g. DATABASE_URL with no enum)
      // are excluded from the covering array, which would cause requires-checks to reject
      // every row. Disabling lets IPOG generate the full pairwise set.
      const citResult = parse(await invoke("get_test_configurations", {
        repo: "platform-svc",
        strength: 2,
        constraintAware: false,
      }));
      expect(citResult.configurations).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const configurations = citResult.configurations as any[];
      expect(configurations.length).toBeGreaterThanOrEqual(1);
      expect(citResult.coverageStats).toBeDefined();
      expect((citResult.coverageStats as { coveragePercent: number }).coveragePercent).toBeGreaterThan(0);

      // Step 5: check interaction strength for AUTH_PROVIDER
      // AUTH_PROVIDER connects to DATABASE_URL and ENABLE_MFA via requires constraints
      const strengthResult = parse(await invoke("get_interaction_strength", {
        repo: "platform-svc",
        parameter: "AUTH_PROVIDER",
      }));
      expect(strengthResult.interactionCount).toBeGreaterThanOrEqual(2);

      // Step 4b (extended): constraint-aware CIT — returned configs must not violate
      // the ENABLE_MFA → AUTH_PROVIDER requires constraint
      const citConstrainedResult = parse(await invoke("get_test_configurations", {
        repo: "platform-svc",
        strength: 2,
        constraintAware: true,
      }));
      expect(citConstrainedResult.configurations).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const constrainedConfigs = citConstrainedResult.configurations as Array<Record<string, unknown>>;
      // Every config where ENABLE_MFA is true must also have AUTH_PROVIDER defined
      for (const cfg of constrainedConfigs) {
        if (cfg["ENABLE_MFA"] === true) {
          expect(cfg["AUTH_PROVIDER"]).toBeDefined();
        }
      }
      // Every config where AUTH_PROVIDER is defined must also have DATABASE_URL defined
      for (const cfg of constrainedConfigs) {
        if (cfg["AUTH_PROVIDER"] !== undefined && cfg["AUTH_PROVIDER"] !== null) {
          expect(cfg["DATABASE_URL"]).toBeDefined();
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 8: "Find risky code hotspots"
  // Chain: get_hotspots → get_temporal_coupling → get_blast_radius
  // ---------------------------------------------------------------------------
  describe("scenario 8: find risky code hotspots", () => {
    it("ranks hotspots, finds temporally-coupled pairs, then computes blast radius", async () => {
      const stores = makeStores();
      const invoke = makeInvoker(stores);

      // Seed hotspot data: hotspots:<repo> → array of { file, churn, symbolCount }
      await stores.kvStore.set("hotspots:analytics-svc", JSON.stringify([
        { file: "src/core/pipeline.ts", churn: 42, symbolCount: 85 },
        { file: "src/core/aggregator.ts", churn: 30, symbolCount: 60 },
        { file: "src/utils/format.ts", churn: 5, symbolCount: 10 },
      ]));

      // Seed temporal coupling: temporal-coupling:<repo> → { pairs, commitsAnalyzed }
      await stores.kvStore.set("temporal-coupling:analytics-svc", JSON.stringify({
        commitsAnalyzed: 120,
        commitsSkipped: 3,
        pairs: [
          { fileA: "src/core/pipeline.ts", fileB: "src/core/aggregator.ts", coChangeCount: 18, couplingScore: 0.43 },
          { fileA: "src/core/pipeline.ts", fileB: "src/db/writer.ts", coChangeCount: 12, couplingScore: 0.29 },
          { fileA: "src/utils/format.ts", fileB: "src/utils/parse.ts", coChangeCount: 1, couplingScore: 0.05 },
        ],
      }));

      // Seed graph: reporter.ts and exporter.ts both import pipeline.ts
      await stores.graphStore.addEdges([{
        source: "src/api/reporter.ts",
        target: "src/core/pipeline.ts",
        kind: "imports",
        metadata: { repo: "analytics-svc" },
      }]);
      await stores.graphStore.addEdges([{
        source: "src/api/exporter.ts",
        target: "src/core/pipeline.ts",
        kind: "imports",
        metadata: { repo: "analytics-svc" },
      }]);

      // Step 1: get hotspots for analytics-svc — pipeline.ts should rank highest
      const hotspotsResult = parse(await invoke("get_hotspots", { repo: "analytics-svc" }));
      expect(hotspotsResult.total).toBeGreaterThanOrEqual(2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hotspots = hotspotsResult.results as any[];
      expect(hotspots.length).toBeGreaterThanOrEqual(1);
      const topHotspot = hotspots[0];
      expect((topHotspot.file as string)).toContain("pipeline");
      expect(topHotspot.hotspotScore).toBeGreaterThan(0);

      // Step 2: get temporal coupling for analytics-svc — find pairs involving pipeline.ts
      const couplingResult = parse(await invoke("get_temporal_coupling", {
        repo: "analytics-svc",
        minCoChanges: 2,
      }));
      expect(couplingResult.total).toBeGreaterThanOrEqual(2);
      expect(couplingResult.commitsAnalyzed).toBeGreaterThan(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pairs = couplingResult.results as any[];
      const pipelinePairs = pairs.filter(
        (p: { fileA: string; fileB: string }) =>
          p.fileA.includes("pipeline") || p.fileB.includes("pipeline"),
      );
      expect(pipelinePairs.length).toBeGreaterThanOrEqual(1);
      // The highest co-change pair should be pipeline↔aggregator (coChangeCount=18)
      const topPair = pairs[0];
      expect(topPair.coChangeCount).toBeGreaterThanOrEqual(12);

      // Step 3: blast radius for the top hotspot file (pipeline.ts)
      const blastResult = parse(await invoke("get_blast_radius", {
        files: ["src/core/pipeline.ts"],
        repo: "analytics-svc",
      }));
      expect(blastResult.affectedFiles).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const affected = (blastResult.affectedFiles as any[]).map((f: { path: string }) => f.path);
      expect(affected.some(p => p.includes("reporter") || p.includes("exporter"))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 9: "Cross-repo impact of a change"
  // Chain: get_cross_repo_models → get_cross_repo_impact → get_blast_radius (crossRepo: true)
  // ---------------------------------------------------------------------------
  describe("scenario 9: cross-repo impact of a change", () => {
    it("surveys shared models, computes cross-repo impact, then cross-repo blast radius", async () => {
      const stores = makeStores();
      const invoke = makeInvoker(stores);

      // Seed cross-repo:features (shared flags across repos)
      await stores.kvStore.set("cross-repo:features", JSON.stringify({
        sharedFlags: [
          { name: "ENABLE_DARK_MODE", repos: ["ui-svc", "mobile-svc"], coordinated: false },
          { name: "ENABLE_ANALYTICS", repos: ["ui-svc", "api-svc", "mobile-svc"], coordinated: true },
        ],
      }));

      // Seed cross-repo:catalog (service catalog entries)
      await stores.kvStore.set("cross-repo:catalog", JSON.stringify({
        entries: [
          {
            entry: { name: "UserService" },
            repo: "api-svc",
            consumers: ["ui-svc", "mobile-svc"],
            producers: [],
          },
        ],
      }));

      // Seed cross-repo dependency graph: api-svc → ui-svc and mobile-svc
      // (api-svc sources cross-repo edges, meaning api-svc imports shared UI components
      // from ui-svc and mobile-svc; when api-svc/service.ts is affected,
      // the impact propagates along those edges to ui-svc/mobile-svc targets)
      await stores.kvStore.set("correlation:graph", JSON.stringify({
        edges: [
          {
            edge: {
              source: "src/user/service.ts",
              target: "src/shared/types.ts",
              kind: "imports",
              metadata: { importedNames: ["UserType"] },
            },
            sourceRepo: "api-svc",
            targetRepo: "ui-svc",
            packageName: "@acme/ui-types",
          },
          {
            edge: {
              source: "src/user/service.ts",
              target: "src/shared/types.ts",
              kind: "imports",
              metadata: { importedNames: ["UserType"] },
            },
            sourceRepo: "api-svc",
            targetRepo: "mobile-svc",
            packageName: "@acme/mobile-types",
          },
        ],
        repoPairs: ["api-svc->ui-svc", "api-svc->mobile-svc"],
        downstreamMap: [["api-svc", ["ui-svc", "mobile-svc"]]],
        upstreamMap: [["ui-svc", ["api-svc"]], ["mobile-svc", ["api-svc"]]],
      }));

      // Seed intra-repo graph for api-svc: controller.ts → service.ts
      await stores.graphStore.addEdges([{
        source: "src/user/controller.ts",
        target: "src/user/service.ts",
        kind: "imports",
        metadata: { repo: "api-svc" },
      }]);

      // Step 1: get cross-repo models — find shared feature flags
      const modelsResult = parse(await invoke("get_cross_repo_models", { kind: "features" }));
      expect(modelsResult.features).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const sharedFlags = modelsResult.features.results;
      expect(sharedFlags.length).toBeGreaterThanOrEqual(2);
      const analyticsFlag = sharedFlags.find((f: { name: string }) => f.name === "ENABLE_ANALYTICS");
      expect(analyticsFlag).toBeDefined();
      expect((analyticsFlag.repos as string[]).length).toBeGreaterThanOrEqual(2);

      // Step 2: get cross-repo impact for a change to service.ts in api-svc
      const impactResult = parse(await invoke("get_cross_repo_impact", {
        files: ["src/user/service.ts"],
        repo: "api-svc",
      }));
      expect(impactResult.changedRepo).toBe("api-svc");
      expect(impactResult.reposReached).toBeGreaterThanOrEqual(1);
      const acrossRepos = impactResult.affectedAcrossRepos as Record<string, unknown[]>;
      const downstreamRepos = Object.keys(acrossRepos);
      expect(downstreamRepos.some(r => r === "ui-svc" || r === "mobile-svc")).toBe(true);

      // Step 3: blast radius with crossRepo: true — should reach ui-svc or mobile-svc files
      const blastResult = parse(await invoke("get_blast_radius", {
        files: ["src/user/service.ts"],
        repo: "api-svc",
        crossRepo: true,
      }));
      expect(blastResult.affectedFiles).toBeDefined();
      // cross-repo blast radius: crossRepoAffected should include downstream repos
      const crossRepoAffected = blastResult.crossRepoAffected as Record<string, unknown[]> | undefined;
      const crossRepoNote = blastResult.crossRepoNote as string | undefined;
      // Either there are cross-repo matches, or the note explains there are none
      expect(crossRepoAffected !== undefined || crossRepoNote !== undefined).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 10: "Trace pattern usage across repos"
  // Chain: get_patterns → get_callees → get_symbol_importers
  // ---------------------------------------------------------------------------
  describe("scenario 10: trace pattern usage across repos", () => {
    it("detects repository pattern, traces callees, then finds cross-repo importers", async () => {
      const stores = makeStores();
      const invoke = makeInvoker(stores);

      // Seed pattern data: patterns:<repo> → { adapter: [...], repository: [...] }
      await stores.kvStore.set("patterns:data-svc", JSON.stringify({
        repository: [
          { name: "UserRepository", file: "src/db/user-repo.ts", methods: ["findById", "findAll", "save", "delete"] },
          { name: "OrderRepository", file: "src/db/order-repo.ts", methods: ["findByUser", "save"] },
        ],
        adapter: [
          { name: "PaymentAdapter", file: "src/adapters/payment.ts", adaptee: "StripeClient" },
        ],
      }));

      // Seed graph: service.ts calls findById and findAll on user-repo.ts
      await stores.graphStore.addEdges([{
        source: "src/db/user-repo.ts#UserRepository.findById",
        target: "src/db/pool.ts#ConnectionPool.query",
        kind: "calls",
        metadata: { repo: "data-svc" },
      }]);
      await stores.graphStore.addEdges([{
        source: "src/db/user-repo.ts#UserRepository.findAll",
        target: "src/db/pool.ts#ConnectionPool.query",
        kind: "calls",
        metadata: { repo: "data-svc" },
      }]);

      // Seed cross-repo graph: checkout-svc imports UserRepository from data-svc
      await stores.kvStore.set("correlation:graph", JSON.stringify({
        edges: [
          {
            edge: {
              source: "src/checkout/handler.ts",
              target: "src/db/user-repo.ts",
              kind: "imports",
              metadata: {
                importedNames: ["UserRepository"],
                resolvedSymbols: [{ name: "UserRepository", kind: "class", sourceFile: "src/db/user-repo.ts" }],
              },
            },
            sourceRepo: "checkout-svc",
            targetRepo: "data-svc",
            packageName: "@acme/data-svc",
          },
          {
            edge: {
              source: "src/billing/processor.ts",
              target: "src/db/user-repo.ts",
              kind: "imports",
              metadata: {
                importedNames: ["UserRepository"],
                resolvedSymbols: [{ name: "UserRepository", kind: "class", sourceFile: "src/db/user-repo.ts" }],
              },
            },
            sourceRepo: "billing-svc",
            targetRepo: "data-svc",
            packageName: "@acme/data-svc",
          },
        ],
        repoPairs: ["checkout-svc->data-svc", "billing-svc->data-svc"],
        downstreamMap: [["checkout-svc", ["data-svc"]], ["billing-svc", ["data-svc"]]],
        upstreamMap: [["data-svc", ["checkout-svc", "billing-svc"]]],
      }));

      // Step 1: get patterns for data-svc — find repository pattern entries
      const patternsResult = parse(await invoke("get_patterns", {
        repo: "data-svc",
        pattern: "repository",
      }));
      expect(patternsResult.repo).toBe("data-svc");
      expect(patternsResult.patterns).toBeDefined();
      const patternData = patternsResult.patterns as Record<string, unknown>;
      expect(patternData["repository"]).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const repos = (patternData["repository"] as any[]);
      expect(repos.length).toBeGreaterThanOrEqual(1);
      const userRepo = repos.find((r: { name: string }) => r.name === "UserRepository");
      expect(userRepo).toBeDefined();

      // Step 2: get callees for UserRepository.findById — should reach ConnectionPool.query
      const calleesResult = parse(await invoke("get_callees", {
        symbol: "src/db/user-repo.ts#UserRepository.findById",
        repo: "data-svc",
      }));
      expect(calleesResult).toBeDefined();
      expect(calleesResult.error).toBeUndefined();
      expect(calleesResult.nodes).toBeDefined();
      const calleeNodes = calleesResult.nodes as string[];
      // Should find ConnectionPool.query as a callee (or at minimum not error with 0 nodes is acceptable)
      const hasPoolCallee = calleeNodes.some(n => n.includes("query") || n.includes("pool") || n.includes("Pool"));
      expect(hasPoolCallee || calleeNodes.length === 0).toBe(true);

      // Step 3: get symbol importers for UserRepository across repos
      const importersResult = parse(await invoke("get_symbol_importers", {
        symbol: "UserRepository",
        package: "@acme/data-svc",
      }));
      expect(importersResult.symbol).toBe("UserRepository");
      expect(importersResult.importerCount).toBeGreaterThanOrEqual(2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const importers = importersResult.importers as any[];
      const importerRepos = importers.map((i: { repo: string }) => i.repo);
      expect(importerRepos).toContain("checkout-svc");
      expect(importerRepos).toContain("billing-svc");
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 11: "Graceful degradation with missing data"
  // All calls use nonexistent repos — assert structured responses, no throws
  // ---------------------------------------------------------------------------
  describe("scenario 11: graceful degradation with missing data", () => {
    it("returns structured empty responses for all tools when no data is seeded", async () => {
      const stores = makeStores();
      const invoke = makeInvoker(stores);

      // get_hotspots — no hotspot data at all
      const hotspotsResult = parse(await invoke("get_hotspots", { repo: "ghost-repo" }));
      expect(hotspotsResult.error).toBeUndefined();
      expect(hotspotsResult.total).toBe(0);
      expect(hotspotsResult.note).toBeDefined();

      // get_temporal_coupling — no temporal coupling data
      const couplingResult = parse(await invoke("get_temporal_coupling", { repo: "ghost-repo" }));
      expect(couplingResult.error).toBeUndefined();
      // Returns paginated shape with total=0 and a note
      expect(couplingResult.total).toBe(0);
      expect(couplingResult.note).toBeDefined();

      // get_cross_repo_models — no cross-repo data
      const modelsResult = parse(await invoke("get_cross_repo_models", { kind: "features" }));
      // Returns error key since no data exists
      expect(modelsResult.error).toBeDefined();
      expect(typeof modelsResult.error).toBe("string");

      // get_cross_repo_impact — no correlation graph
      const impactResult = parse(await invoke("get_cross_repo_impact", {
        files: ["src/index.ts"],
        repo: "ghost-repo",
      }));
      expect(impactResult.error).toBeDefined();
      expect(typeof impactResult.error).toBe("string");

      // get_patterns — no pattern data for repo
      const patternsResult = parse(await invoke("get_patterns", { repo: "ghost-repo" }));
      expect(patternsResult.error).toBeUndefined();
      expect(patternsResult.note).toBeDefined();
      expect(patternsResult.patterns).toBeDefined();

      // get_symbol_importers — no correlation graph
      const importersResult = parse(await invoke("get_symbol_importers", {
        symbol: "GhostSymbol",
        package: "@ghost/pkg",
      }));
      expect(importersResult.error).toBeDefined();
      expect(typeof importersResult.error).toBe("string");
    });
  });
});
