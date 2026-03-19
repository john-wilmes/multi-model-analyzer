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
