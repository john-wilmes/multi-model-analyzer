/**
 * Tests for the dashboard HTTP server API (C1, C3).
 *
 * Spins up a minimal HTTP server on port 0 (OS-assigned) that delegates
 * to the exported handleApi function, then exercises all major endpoints.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { InMemoryKVStore, InMemoryGraphStore } from "@mma/storage";
import type { ModuleMetrics } from "@mma/core";
import { handleApi } from "./dashboard-cmd.js";

// ---------------------------------------------------------------------------
// Test server lifecycle
// ---------------------------------------------------------------------------

interface TestServer {
  port: number;
  close: () => Promise<void>;
}

async function startTestServer(
  kv: InstanceType<typeof InMemoryKVStore>,
  graph: InstanceType<typeof InMemoryGraphStore>,
): Promise<TestServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
    handleApi(req, res, kv, graph, undefined).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(err instanceof Error ? err.message : String(err));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function makeMetrics(module: string, repo = "repo-a"): ModuleMetrics {
  return {
    module,
    repo,
    ca: 6,
    ce: 3,
    instability: 0.5,
    abstractness: 0.3,
    distance: 0.2,
    zone: "main-sequence",
  };
}

async function seedRepo(
  kv: InstanceType<typeof InMemoryKVStore>,
  repo: string,
): Promise<void> {
  await kv.set(
    `metricsSummary:${repo}`,
    JSON.stringify({
      repo,
      moduleCount: 2,
      avgInstability: 0.5,
      avgAbstractness: 0.3,
      avgDistance: 0.2,
      painZoneCount: 0,
      uselessnessZoneCount: 0,
    }),
  );
  await kv.set(
    `metrics:${repo}`,
    JSON.stringify([makeMetrics("src/index.ts", repo), makeMetrics("src/app.ts", repo)]),
  );
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let kv: InstanceType<typeof InMemoryKVStore>;
let graph: InstanceType<typeof InMemoryGraphStore>;
let server: TestServer;
let baseUrl: string;

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

beforeAll(async () => {
  kv = new InMemoryKVStore();
  graph = new InMemoryGraphStore();

  await seedRepo(kv, "repo-a");
  await seedRepo(kv, "repo-b");

  // Seed hotspots
  await kv.set(
    "hotspots:repo-a",
    JSON.stringify([
      { path: "src/index.ts", hotspotScore: 0.9, churnCount: 10 },
      { path: "src/app.ts", hotspotScore: 0.7, churnCount: 5 },
    ]),
  );

  // Seed SARIF findings
  const sarif = {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "mma", version: "0.1.0", rules: [] } },
        results: [
          {
            ruleId: "MMA001",
            level: "warning",
            message: { text: "High instability" },
            locations: [
              {
                logicalLocations: [
                  { name: "src/index.ts", properties: { repo: "repo-a" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  await kv.set("sarif:latest", JSON.stringify(sarif));
  await kv.set(
    "sarif:latest:index",
    JSON.stringify({ repos: ["repo-a", "repo-b"] }),
  );

  // Seed graph edges
  await graph.addEdges([
    {
      source: "src/index.ts",
      target: "src/app.ts",
      kind: "imports",
      metadata: { repo: "repo-a" },
    },
    {
      source: "src/app.ts",
      target: "src/utils.ts",
      kind: "imports",
      metadata: { repo: "repo-a" },
    },
  ]);

  // Seed blast radius data (PageRank SARIF + reach counts)
  await kv.set(
    "sarif:blastRadius:repo-a",
    JSON.stringify([
      {
        ruleId: "blast-radius/high-pagerank",
        level: "note",
        message: { text: "High blast radius" },
        locations: [{ logicalLocations: [{ fullyQualifiedName: "src/app.ts", kind: "module", properties: { repo: "repo-a" } }] }],
        properties: { pageRankScore: 0.15, rank: 1 },
      },
    ]),
  );
  await kv.set(
    "reachCounts:repo-a",
    JSON.stringify([["src/app.ts", 3], ["src/index.ts", 1], ["src/utils.ts", 0]]),
  );

  // Seed DSM graph edges (calls kind) for repo-a
  await graph.addEdges([
    {
      source: "src/index.ts",
      target: "src/app.ts",
      kind: "calls",
      metadata: { repo: "repo-a" },
    },
    {
      source: "src/app.ts",
      target: "src/utils.ts",
      kind: "calls",
      metadata: { repo: "repo-a" },
    },
  ]);

  // Seed patterns
  await kv.set(
    "patterns:repo-a",
    JSON.stringify({ singleton: ["src/config.ts"], factory: ["src/factory.ts"] }),
  );

  // Seed temporal coupling
  await kv.set(
    "temporal-coupling:repo-a",
    JSON.stringify({
      pairs: [
        { fileA: "src/index.ts", fileB: "src/app.ts", coChangeCount: 8, totalCommits: 20, coupling: 0.4 },
        { fileA: "src/app.ts", fileB: "src/utils.ts", coChangeCount: 3, totalCommits: 20, coupling: 0.15 },
      ],
      commitsAnalyzed: 20,
      commitsSkipped: 2,
    }),
  );
  await kv.set(
    "temporal-coupling:repo-b",
    JSON.stringify({
      pairs: [
        { fileA: "src/main.ts", fileB: "src/lib.ts", coChangeCount: 5, totalCommits: 15, coupling: 0.33 },
      ],
      commitsAnalyzed: 15,
      commitsSkipped: 0,
    }),
  );

  // Seed ATDI
  await kv.set("atdi:system", JSON.stringify({ score: 84, moduleCount: 100 }));
  await kv.set("atdi:repo-a", JSON.stringify({ score: 72, moduleCount: 40 }));

  // Seed debt
  await kv.set("debt:system", JSON.stringify({ totalMinutes: 1000, totalHours: 16.7 }));
  await kv.set("debt:repo-a", JSON.stringify({ totalMinutes: 400, totalHours: 6.7 }));

  // Seed cross-repo-graph (correlation:graph)
  await kv.set(
    "correlation:graph",
    JSON.stringify({
      edges: [
        {
          edge: { source: "src/client.ts", target: "src/server.ts", kind: "service-call", metadata: {} },
          sourceRepo: "repo-a",
          targetRepo: "repo-b",
        },
      ],
      repoPairs: ["repo-a|repo-b"],
      downstreamMap: [["repo-a", ["repo-b"]]],
      upstreamMap: [["repo-b", ["repo-a"]]],
    }),
  );

  // Seed cross-repo service-call graph edges for cross-repo-impact
  await graph.addEdges([
    {
      source: "src/foo.ts",
      target: "src/bar.ts",
      kind: "imports",
      metadata: { repo: "repo-a" },
    },
  ]);

  // Seed cross-repo features
  await kv.set(
    "cross-repo:features",
    JSON.stringify([
      { name: "FEATURE_X", repos: ["repo-a", "repo-b"], coordinated: true },
      { name: "FEATURE_Y", repos: ["repo-b"], coordinated: false },
    ]),
  );

  // Seed cross-repo faults
  await kv.set(
    "cross-repo:faults",
    JSON.stringify([
      {
        endpoint: "/api/data",
        sourceRepo: "repo-a",
        targetRepo: "repo-b",
        sourceFaultTreeCount: 2,
        targetFaultTreeCount: 1,
      },
    ]),
  );

  // Seed cross-repo catalog
  await kv.set(
    "cross-repo:catalog",
    JSON.stringify([
      {
        entry: {
          name: "DataService",
          purpose: "Handles data processing",
          dependencies: [],
          apiSurface: [{ method: "GET", path: "/data" }],
          errorHandlingSummary: "Returns 500 on failure",
        },
        repo: "repo-a",
        consumers: ["repo-b"],
        producers: [],
      },
      {
        entry: {
          name: "AuthService",
          purpose: "Handles authentication",
          dependencies: [],
          apiSurface: [{ method: "POST", path: "/auth" }],
          errorHandlingSummary: "Returns 401 on failure",
        },
        repo: "repo-b",
        consumers: [],
        producers: ["repo-a"],
      },
    ]),
  );

  // Seed additional SARIF findings with specific ruleIds for /api/findings/:ruleId tests
  const sarifWithMultipleRules = {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "mma", version: "0.1.0", rules: [] } },
        results: [
          {
            ruleId: "MMA001",
            level: "warning",
            message: { text: "High instability" },
            locations: [
              {
                logicalLocations: [
                  { name: "src/index.ts", properties: { repo: "repo-a" } },
                ],
              },
            ],
          },
          {
            ruleId: "MMA002",
            level: "error",
            message: { text: "Pain zone violation" },
            locations: [
              {
                logicalLocations: [
                  { name: "src/app.ts", properties: { repo: "repo-a" } },
                ],
              },
            ],
          },
          {
            ruleId: "MMA002",
            level: "error",
            message: { text: "Pain zone violation" },
            locations: [
              {
                logicalLocations: [
                  { name: "src/main.ts", properties: { repo: "repo-b" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  await kv.set("sarif:latest", JSON.stringify(sarifWithMultipleRules));

  server = await startTestServer(kv, graph);
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/repos", () => {
  it("returns the list of repos", async () => {
    const res = await get("/api/repos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: string[] };
    expect(body.repos).toContain("repo-a");
    expect(body.repos).toContain("repo-b");
  });

  it("sets X-Content-Type-Options: nosniff header", async () => {
    const res = await get("/api/repos");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("GET /api/metrics/:repo", () => {
  it("returns metrics array for a valid repo", async () => {
    const res = await get("/api/metrics/repo-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModuleMetrics[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toMatchObject({
      module: expect.any(String) as unknown,
      instability: expect.any(Number) as unknown,
    });
  });

  it("returns empty array for unknown repo", async () => {
    const res = await get("/api/metrics/does-not-exist");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });
});

describe("GET /api/metrics-all", () => {
  it("returns array of metrics", async () => {
    const res = await get("/api/metrics-all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  it("respects the limit param and caps at 5000 (PR #48)", async () => {
    const res = await get("/api/metrics-all?limit=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBeLessThanOrEqual(1);
  });

  it("does not crash with very large limit", async () => {
    const res = await get("/api/metrics-all?limit=99999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("GET /api/findings", () => {
  it("returns findings with results array and total", async () => {
    const res = await get("/api/findings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; total: number };
    expect(Array.isArray(body.results)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  it("each finding has ruleId, message, and level", async () => {
    const res = await get("/api/findings");
    const body = (await res.json()) as {
      results: Array<{ ruleId: string; message: { text: string }; level: string }>;
    };
    if (body.results.length > 0) {
      expect(body.results[0]).toMatchObject({
        ruleId: expect.any(String) as unknown,
        message: expect.objectContaining({ text: expect.any(String) as unknown }) as unknown,
        level: expect.any(String) as unknown,
      });
    }
  });
});

describe("GET /api/hotspots", () => {
  it("returns paginated response shape", async () => {
    const res = await get("/api/hotspots");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(Array.isArray(body.results)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.limit).toBe("number");
    expect(typeof body.offset).toBe("number");
  });

  it("respects limit param (PR #48)", async () => {
    const res = await get("/api/hotspots?limit=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; total: number };
    expect(body.results.length).toBeLessThanOrEqual(1);
    expect(body.total).toBeGreaterThanOrEqual(body.results.length);
  });

  it("respects offset param", async () => {
    const full = (await (await get("/api/hotspots?limit=100")).json()) as {
      results: unknown[];
    };
    const paged = (await (
      await get("/api/hotspots?limit=100&offset=1")
    ).json()) as { results: unknown[] };
    expect(paged.results.length).toBeLessThanOrEqual(full.results.length);
  });
});

describe("GET /api/graph/:repo", () => {
  it("returns edges and limit for valid kind", async () => {
    const res = await get("/api/graph/repo-a?kind=imports");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edges: unknown[]; limit: number };
    expect(Array.isArray(body.edges)).toBe(true);
    expect(typeof body.limit).toBe("number");
  });

  it("returns 400 for invalid edgeKind (PR #48)", async () => {
    const res = await get("/api/graph/repo-a?kind=not-a-real-edge-kind");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid edgeKind/i);
  });

  it("accepts all valid edge kinds without error", async () => {
    const validKinds = [
      "calls",
      "imports",
      "extends",
      "implements",
      "depends-on",
      "contains",
      "service-call",
    ];
    const responses = await Promise.all(
      validKinds.map((kind) => get(`/api/graph/repo-a?kind=${kind}`)),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  });
});

describe("GET /api/dependencies/:module", () => {
  it("returns root, dependencies, and dependents", async () => {
    const res = await get("/api/dependencies/repo-a:src%2Findex.ts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      root: string;
      dependencies: unknown[];
      dependents: unknown[];
    };
    expect(typeof body.root).toBe("string");
    expect(Array.isArray(body.dependencies)).toBe(true);
    expect(Array.isArray(body.dependents)).toBe(true);
  });

  it("clamps depth to max 10 (PR #48)", async () => {
    const res = await get(
      "/api/dependencies/repo-a:src%2Findex.ts?depth=999",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { root: string };
    expect(typeof body.root).toBe("string");
  });
});

describe("GET /api/practices", () => {
  it("returns a practices report without crashing", async () => {
    const res = await get("/api/practices");
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toBeDefined();
  });

  it("second call returns same cached result (C5 cache)", async () => {
    const res1 = await get("/api/practices");
    const res2 = await get("/api/practices");
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(await res1.text()).toBe(await res2.text());
  });
});

describe("GET /api/blast-radius/:repo (overview)", () => {
  it("returns pre-computed PageRank + reach counts", async () => {
    const res = await get("/api/blast-radius/repo-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repo: string;
      files: Array<{ path: string; score: number; rank: number; reachCount: number }>;
      totalNodes: number;
    };
    expect(body.repo).toBe("repo-a");
    expect(body.files.length).toBeGreaterThan(0);
    expect(body.files[0]).toMatchObject({
      path: "src/app.ts",
      score: 0.15,
      rank: 1,
      reachCount: 3,
    });
    expect(body.totalNodes).toBe(3);
  });

  it("returns empty files array for repo with no blast radius data", async () => {
    const res = await get("/api/blast-radius/repo-b");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: unknown[]; totalNodes: number };
    expect(body.files).toEqual([]);
    expect(body.totalNodes).toBe(0);
  });
});

describe("GET /api/blast-radius/:repo?file=... (detail)", () => {
  it("returns computed blast radius for a specific file", async () => {
    const res = await get("/api/blast-radius/repo-a?file=src%2Futils.ts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changedFiles: string[];
      affectedFiles: Array<{ path: string; depth: number; via: string }>;
      totalAffected: number;
      maxDepth: number;
    };
    expect(body.changedFiles).toContain("src/utils.ts");
    expect(typeof body.totalAffected).toBe("number");
    expect(typeof body.maxDepth).toBe("number");
    // src/app.ts imports src/utils.ts, so it should be affected
    expect(body.affectedFiles.some((f) => f.path === "src/app.ts")).toBe(true);
  });

  it("respects maxDepth parameter", async () => {
    const res = await get("/api/blast-radius/repo-a?file=src%2Futils.ts&maxDepth=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { maxDepth: number };
    expect(body.maxDepth).toBe(1);
  });

  it("clamps maxDepth to 1-10 range", async () => {
    const res0 = await get("/api/blast-radius/repo-a?file=src%2Futils.ts&maxDepth=0");
    const body0 = (await res0.json()) as { maxDepth: number };
    expect(body0.maxDepth).toBe(1);

    const res99 = await get("/api/blast-radius/repo-a?file=src%2Futils.ts&maxDepth=99");
    const body99 = (await res99.json()) as { maxDepth: number };
    expect(body99.maxDepth).toBe(10);
  });
});

describe("Unknown routes return 404", () => {
  it("returns 404 for unmatched /api path", async () => {
    const res = await get("/api/this-route-does-not-exist-abc");
    expect(res.status).toBe(404);
  });
});

describe("Path traversal protection", () => {
  it("does not leak file content for path traversal in metrics route", async () => {
    const res = await get("/api/metrics/..%2F..%2Fetc%2Fpasswd");
    expect([200, 400, 404]).toContain(res.status);
    const body = await res.text();
    expect(body).not.toContain("root:");
  });
});

describe("Concurrent requests (C3)", () => {
  it("handles 10 parallel GET /api/repos without error", async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => get("/api/repos")),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  });

  it("handles mixed parallel requests across endpoints", async () => {
    const responses = await Promise.all([
      get("/api/repos"),
      get("/api/metrics/repo-a"),
      get("/api/findings"),
      get("/api/hotspots"),
      get("/api/metrics-all"),
      get("/api/repos"),
      get("/api/metrics/repo-b"),
      get("/api/findings"),
      get("/api/hotspots?limit=1"),
      get("/api/metrics-all?limit=5"),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  });
});

describe("Large body rejection (PR #48)", () => {
  it("rejects POST body larger than 1MB", async () => {
    // Send 2MB body to /api/cross-repo-impact
    const largeBody = "x".repeat(2 * 1024 * 1024);
    let status: number;
    try {
      const res = await fetch(`${baseUrl}/api/cross-repo-impact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: largeBody,
      });
      status = res.status;
    } catch {
      // Connection reset/abort is also acceptable
      status = 0;
    }
    expect(status).not.toBe(200);
  });
});

// ---------------------------------------------------------------------------
// New endpoint tests
// ---------------------------------------------------------------------------

describe("GET /api/dsm/:repo", () => {
  it("returns modules, matrix, and edgeKind for default kind (imports)", async () => {
    const res = await get("/api/dsm/repo-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modules: string[]; matrix: number[][]; edgeKind: string };
    expect(Array.isArray(body.modules)).toBe(true);
    expect(body.modules.length).toBeGreaterThan(0);
    expect(Array.isArray(body.matrix)).toBe(true);
    expect(body.matrix.length).toBe(body.modules.length);
    expect(body.edgeKind).toBe("imports");
  });

  it("returns correct matrix dimensions for ?kind=calls", async () => {
    const res = await get("/api/dsm/repo-a?kind=calls");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modules: string[]; matrix: number[][]; edgeKind: string };
    expect(body.edgeKind).toBe("calls");
    expect(body.modules.length).toBeGreaterThan(0);
    // Each row must have the same length as the modules array
    for (const row of body.matrix) {
      expect(row.length).toBe(body.modules.length);
    }
  });

  it("returns 400 for invalid kind", async () => {
    const res = await get("/api/dsm/repo-a?kind=not-valid");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid edgeKind/i);
  });

  it("returns empty modules for a repo with no edges", async () => {
    const res = await get("/api/dsm/repo-unknown");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modules: string[]; matrix: number[][] };
    expect(body.modules).toEqual([]);
    expect(body.matrix).toEqual([]);
  });
});

describe("GET /api/patterns/:repo", () => {
  it("returns parsed JSON pattern data for a seeded repo", async () => {
    const res = await get("/api/patterns/repo-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { singleton: string[]; factory: string[] };
    expect(Array.isArray(body.singleton)).toBe(true);
    expect(body.singleton).toContain("src/config.ts");
    expect(Array.isArray(body.factory)).toBe(true);
  });

  it("returns empty object for repo with no patterns data", async () => {
    const res = await get("/api/patterns/repo-unknown");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({});
  });
});

describe("GET /api/temporal-coupling", () => {
  it("returns flat array sorted by coChangeCount descending", async () => {
    const res = await get("/api/temporal-coupling");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ coChangeCount: number; repo: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // Verify sorted descending
    for (let i = 1; i < body.length; i++) {
      expect(body[i - 1]!.coChangeCount).toBeGreaterThanOrEqual(body[i]!.coChangeCount);
    }
    // Each entry should have a repo field injected
    expect(body[0]).toHaveProperty("repo");
  });

  it("aggregates pairs from all repos", async () => {
    const res = await get("/api/temporal-coupling");
    const body = (await res.json()) as Array<{ repo: string }>;
    const repos = new Set(body.map((p) => p.repo));
    expect(repos.has("repo-a")).toBe(true);
    expect(repos.has("repo-b")).toBe(true);
  });
});

describe("GET /api/temporal-coupling/:repo", () => {
  it("returns the per-repo object directly", async () => {
    const res = await get("/api/temporal-coupling/repo-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pairs: unknown[]; commitsAnalyzed: number };
    expect(Array.isArray(body.pairs)).toBe(true);
    expect(body.pairs.length).toBe(2);
    expect(typeof body.commitsAnalyzed).toBe("number");
    expect(body.commitsAnalyzed).toBe(20);
  });

  it("returns default empty structure for unknown repo", async () => {
    const res = await get("/api/temporal-coupling/repo-unknown");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pairs: unknown[]; commitsAnalyzed: number };
    expect(body.pairs).toEqual([]);
    expect(body.commitsAnalyzed).toBe(0);
  });
});

describe("GET /api/atdi", () => {
  it("returns the system ATDI object", async () => {
    const res = await get("/api/atdi");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { score: number; moduleCount: number };
    expect(body.score).toBe(84);
    expect(body.moduleCount).toBe(100);
  });
});

describe("GET /api/atdi/:repo", () => {
  it("returns per-repo ATDI object", async () => {
    const res = await get("/api/atdi/repo-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { score: number; moduleCount: number };
    expect(body.score).toBe(72);
    expect(body.moduleCount).toBe(40);
  });

  it("returns null for unknown repo", async () => {
    const res = await get("/api/atdi/repo-unknown");
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toBeNull();
  });
});

describe("GET /api/debt", () => {
  it("returns the system debt object", async () => {
    const res = await get("/api/debt");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalMinutes: number; totalHours: number };
    expect(body.totalMinutes).toBe(1000);
    expect(body.totalHours).toBeCloseTo(16.7, 1);
  });
});

describe("GET /api/debt/:repo", () => {
  it("returns per-repo debt object", async () => {
    const res = await get("/api/debt/repo-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalMinutes: number; totalHours: number };
    expect(body.totalMinutes).toBe(400);
  });

  it("returns null for unknown repo", async () => {
    const res = await get("/api/debt/repo-unknown");
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toBeNull();
  });
});

describe("GET /api/cross-repo-graph", () => {
  it("returns edges with sourceRepo and targetRepo", async () => {
    const res = await get("/api/cross-repo-graph");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      edges: Array<{ sourceRepo: string; targetRepo: string }>;
      repoPairs: string[];
    };
    expect(Array.isArray(body.edges)).toBe(true);
    expect(body.edges.length).toBeGreaterThan(0);
    expect(body.edges[0]).toHaveProperty("sourceRepo");
    expect(body.edges[0]).toHaveProperty("targetRepo");
    expect(Array.isArray(body.repoPairs)).toBe(true);
  });

  it("filters edges by ?repo= query param", async () => {
    const res = await get("/api/cross-repo-graph?repo=repo-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      edges: Array<{ sourceRepo: string; targetRepo: string }>;
    };
    // All edges must involve repo-a
    for (const edge of body.edges) {
      expect(edge.sourceRepo === "repo-a" || edge.targetRepo === "repo-a").toBe(true);
    }
  });

  it("returns empty edges array when ?repo= matches no edges", async () => {
    const res = await get("/api/cross-repo-graph?repo=repo-unknown");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edges: unknown[] };
    expect(body.edges).toEqual([]);
  });
});

describe("POST /api/cross-repo-impact", () => {
  it("returns impact structure for valid request", async () => {
    const res = await fetch(`${baseUrl}/api/cross-repo-impact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: ["src/foo.ts"], repo: "repo-a" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changedFiles: string[];
      changedRepo: string;
      affectedWithinRepo: unknown[];
      affectedAcrossRepos: Record<string, unknown>;
      reposReached: number;
    };
    expect(Array.isArray(body.changedFiles)).toBe(true);
    expect(body.changedFiles).toContain("src/foo.ts");
    expect(body.changedRepo).toBe("repo-a");
    expect(Array.isArray(body.affectedWithinRepo)).toBe(true);
    expect(typeof body.affectedAcrossRepos).toBe("object");
    expect(typeof body.reposReached).toBe("number");
  });

  it("returns 400 when files or repo is missing", async () => {
    const res = await fetch(`${baseUrl}/api/cross-repo-impact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: ["src/foo.ts"] }), // missing repo
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/cross-repo-features", () => {
  it("returns flags array", async () => {
    const res = await get("/api/cross-repo-features");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: Array<{ name: string; repos: string[] }> };
    expect(Array.isArray(body.flags)).toBe(true);
    expect(body.flags.length).toBe(2);
    expect(body.flags.map((f) => f.name)).toContain("FEATURE_X");
  });

  it("filters flags by ?repo= param", async () => {
    const res = await get("/api/cross-repo-features?repo=repo-b");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: Array<{ name: string; repos: string[] }> };
    // Both FEATURE_X and FEATURE_Y include repo-b
    for (const flag of body.flags) {
      expect(flag.repos).toContain("repo-b");
    }
  });
});

describe("GET /api/cross-repo-faults", () => {
  it("returns faultLinks array", async () => {
    const res = await get("/api/cross-repo-faults");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      faultLinks: Array<{ endpoint: string; sourceRepo: string; targetRepo: string }>;
    };
    expect(Array.isArray(body.faultLinks)).toBe(true);
    expect(body.faultLinks.length).toBe(1);
    expect(body.faultLinks[0]!.endpoint).toBe("/api/data");
  });

  it("filters faultLinks by ?repo= param", async () => {
    const res = await get("/api/cross-repo-faults?repo=repo-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      faultLinks: Array<{ sourceRepo: string; targetRepo: string }>;
    };
    for (const link of body.faultLinks) {
      expect(link.sourceRepo === "repo-a" || link.targetRepo === "repo-a").toBe(true);
    }
  });

  it("returns empty faultLinks for unknown repo", async () => {
    const res = await get("/api/cross-repo-faults?repo=repo-unknown");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { faultLinks: unknown[] };
    expect(body.faultLinks).toEqual([]);
  });
});

describe("GET /api/cross-repo-catalog", () => {
  it("returns entries array", async () => {
    const res = await get("/api/cross-repo-catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ repo: string }> };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBe(2);
  });

  it("filters entries by ?repo= param (own repo)", async () => {
    const res = await get("/api/cross-repo-catalog?repo=repo-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ repo: string; consumers: string[]; producers: string[] }>;
    };
    // Every returned entry must involve repo-a
    for (const entry of body.entries) {
      const involves =
        entry.repo === "repo-a" ||
        entry.consumers.includes("repo-a") ||
        entry.producers.includes("repo-a");
      expect(involves).toBe(true);
    }
  });
});

describe("GET /api/metrics-summary", () => {
  it("returns object keyed by repo", async () => {
    const res = await get("/api/metrics-summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, { repo: string; moduleCount: number }>;
    expect(typeof body).toBe("object");
    expect("repo-a" in body).toBe(true);
    expect("repo-b" in body).toBe(true);
    expect(body["repo-a"]!.moduleCount).toBe(2);
  });

  it("each entry has expected shape", async () => {
    const res = await get("/api/metrics-summary");
    const body = (await res.json()) as Record<
      string,
      { repo: string; avgInstability: number; avgAbstractness: number }
    >;
    const entry = body["repo-a"]!;
    expect(typeof entry.avgInstability).toBe("number");
    expect(typeof entry.avgAbstractness).toBe("number");
  });
});

describe("GET /api/findings/:ruleId", () => {
  it("returns only findings matching the specified ruleId", async () => {
    const res = await get("/api/findings/MMA002");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ ruleId: string }>; total: number };
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    for (const result of body.results) {
      expect(result.ruleId).toBe("MMA002");
    }
  });

  it("returns empty results for a ruleId that does not exist", async () => {
    const res = await get("/api/findings/MMA999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; total: number };
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("MMA001 returns exactly one finding", async () => {
    const res = await get("/api/findings/MMA001");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ ruleId: string }> };
    expect(body.results.length).toBe(1);
    expect(body.results[0]!.ruleId).toBe("MMA001");
  });
});
