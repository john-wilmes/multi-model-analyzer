import { test, expect } from '@playwright/test';

// Shared state populated by beforeAll
let firstRepo = '';
let firstModule = '';
let firstRuleId = '';

test.describe('Repos & Metrics', () => {
  test.beforeAll(async ({ request }) => {
    const reposRes = await request.get('/api/repos');
    const reposData = await reposRes.json() as { repos: string[] };
    firstRepo = reposData.repos[0] ?? '';

    if (firstRepo) {
      const metricsRes = await request.get(`/api/metrics/${encodeURIComponent(firstRepo)}`);
      const metricsData = await metricsRes.json() as Array<{ module: string }>;
      firstModule = metricsData[0]?.module ?? '';
    }

    const findingsRes = await request.get('/api/findings?limit=1');
    const findingsData = await findingsRes.json() as { results: Array<{ ruleId?: string }> };
    firstRuleId = findingsData.results[0]?.ruleId ?? '';
  });

  test('GET /api/repos → 200, { repos: string[] }, non-empty', async ({ request }) => {
    const res = await request.get('/api/repos');
    expect(res.status()).toBe(200);
    const data = await res.json() as { repos: string[] };
    expect(Array.isArray(data.repos)).toBe(true);
    expect(data.repos.length).toBeGreaterThan(0);
  });

  test('GET /api/metrics-summary → 200, object with repo keys', async ({ request }) => {
    const res = await request.get('/api/metrics-summary');
    expect(res.status()).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(typeof data).toBe('object');
    expect(data).not.toBeNull();
    expect(Object.keys(data).length).toBeGreaterThan(0);
  });

  test('GET /api/metrics-all → 200, array with module/instability/abstractness', async ({ request }) => {
    const res = await request.get('/api/metrics-all?limit=5');
    expect(res.status()).toBe(200);
    const data = await res.json() as Array<{ module: string; instability: number; abstractness: number }>;
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(typeof data[0]!.module).toBe('string');
      expect(typeof data[0]!.instability).toBe('number');
      expect(typeof data[0]!.abstractness).toBe('number');
    }
  });

  test('GET /api/metrics-all?limit=10 → length <= 10', async ({ request }) => {
    const res = await request.get('/api/metrics-all?limit=10');
    expect(res.status()).toBe(200);
    const data = await res.json() as unknown[];
    expect(data.length).toBeLessThanOrEqual(10);
  });

  test('GET /api/metrics/:repo → 200, array', async ({ request }) => {
    const res = await request.get(`/api/metrics/${encodeURIComponent(firstRepo)}`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });
});

test.describe('DSM', () => {
  test.beforeAll(async ({ request }) => {
    const reposRes = await request.get('/api/repos');
    const reposData = await reposRes.json() as { repos: string[] };
    firstRepo = reposData.repos[0] ?? '';
  });

  test('GET /api/dsm/:repo → 200, { modules, matrix, edgeKind }', async ({ request }) => {
    const res = await request.get(`/api/dsm/${encodeURIComponent(firstRepo)}`);
    expect(res.status()).toBe(200);
    const data = await res.json() as { modules: string[]; matrix: number[][]; edgeKind: string };
    expect(Array.isArray(data.modules)).toBe(true);
    expect(Array.isArray(data.matrix)).toBe(true);
    expect(typeof data.edgeKind).toBe('string');
  });

  test('GET /api/dsm/:repo?kind=invalid → 400', async ({ request }) => {
    const res = await request.get(`/api/dsm/${encodeURIComponent(firstRepo)}?kind=invalid`);
    expect(res.status()).toBe(400);
  });
});

test.describe('Findings', () => {
  test.beforeAll(async ({ request }) => {
    const findingsRes = await request.get('/api/findings?limit=1');
    const findingsData = await findingsRes.json() as { results: Array<{ ruleId?: string }> };
    firstRuleId = findingsData.results[0]?.ruleId ?? '';
  });

  test('GET /api/findings → 200, { results, total, limit, offset }, total > 0', async ({ request }) => {
    const res = await request.get('/api/findings');
    expect(res.status()).toBe(200);
    const data = await res.json() as { results: unknown[]; total: number; limit: number; offset: number };
    expect(Array.isArray(data.results)).toBe(true);
    expect(typeof data.total).toBe('number');
    expect(data.total).toBeGreaterThan(0);
    expect(typeof data.limit).toBe('number');
    expect(typeof data.offset).toBe('number');
  });

  test('GET /api/findings?limit=5 → results.length <= 5', async ({ request }) => {
    const res = await request.get('/api/findings?limit=5');
    expect(res.status()).toBe(200);
    const data = await res.json() as { results: unknown[] };
    expect(data.results.length).toBeLessThanOrEqual(5);
  });

  test('GET /api/findings?level=error → all results have level error', async ({ request }) => {
    const res = await request.get('/api/findings?level=error&limit=20');
    expect(res.status()).toBe(200);
    const data = await res.json() as { results: Array<{ level?: string }> };
    for (const finding of data.results) {
      expect(finding.level).toBe('error');
    }
  });

  test('GET /api/findings/:ruleId → 200', async ({ request }) => {
    if (!firstRuleId) test.skip();
    const res = await request.get(`/api/findings/${encodeURIComponent(firstRuleId)}`);
    expect(res.status()).toBe(200);
  });
});

test.describe('Graph & Dependencies', () => {
  test.beforeAll(async ({ request }) => {
    const reposRes = await request.get('/api/repos');
    const reposData = await reposRes.json() as { repos: string[] };
    firstRepo = reposData.repos[0] ?? '';

    const metricsRes = await request.get(`/api/metrics/${encodeURIComponent(firstRepo)}`);
    const metricsData = await metricsRes.json() as Array<{ module: string }>;
    firstModule = metricsData[0]?.module ?? '';
  });

  test('GET /api/graph/:repo?kind=imports → 200, { edges, limit }', async ({ request }) => {
    const res = await request.get(`/api/graph/${encodeURIComponent(firstRepo)}?kind=imports`);
    expect(res.status()).toBe(200);
    const data = await res.json() as { edges: unknown[]; limit: number };
    expect(Array.isArray(data.edges)).toBe(true);
    expect(typeof data.limit).toBe('number');
  });

  test('GET /api/graph/:repo?kind=badkind → 400', async ({ request }) => {
    const res = await request.get(`/api/graph/${encodeURIComponent(firstRepo)}?kind=badkind`);
    expect(res.status()).toBe(400);
  });

  test('GET /api/dependencies/:module → 200, { root, dependencies, dependents }', async ({ request }) => {
    if (!firstModule) test.skip();
    const res = await request.get(`/api/dependencies/${encodeURIComponent(firstModule)}`);
    expect(res.status()).toBe(200);
    const data = await res.json() as { root: string; dependencies: unknown[]; dependents: unknown[] };
    expect(typeof data.root).toBe('string');
    expect(Array.isArray(data.dependencies)).toBe(true);
    expect(Array.isArray(data.dependents)).toBe(true);
  });
});

test.describe('Practices, Patterns & Hotspots', () => {
  test.beforeAll(async ({ request }) => {
    const reposRes = await request.get('/api/repos');
    const reposData = await reposRes.json() as { repos: string[] };
    firstRepo = reposData.repos[0] ?? '';
  });

  test('GET /api/practices → 200', async ({ request }) => {
    test.setTimeout(45_000);
    const res = await request.get('/api/practices');
    expect(res.status()).toBe(200);
  });

  test('GET /api/patterns/:repo → 200', async ({ request }) => {
    const res = await request.get(`/api/patterns/${encodeURIComponent(firstRepo)}`);
    expect(res.status()).toBe(200);
  });

  test('GET /api/hotspots → 200, { results, total }', async ({ request }) => {
    const res = await request.get('/api/hotspots');
    expect(res.status()).toBe(200);
    const data = await res.json() as { results: unknown[]; total: number };
    expect(Array.isArray(data.results)).toBe(true);
    expect(typeof data.total).toBe('number');
  });
});

test.describe('Temporal Coupling', () => {
  test.beforeAll(async ({ request }) => {
    const reposRes = await request.get('/api/repos');
    const reposData = await reposRes.json() as { repos: string[] };
    firstRepo = reposData.repos[0] ?? '';
  });

  test('GET /api/temporal-coupling → 200, array', async ({ request }) => {
    const res = await request.get('/api/temporal-coupling');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('GET /api/temporal-coupling/:repo → 200, has pairs', async ({ request }) => {
    const res = await request.get(`/api/temporal-coupling/${encodeURIComponent(firstRepo)}`);
    expect(res.status()).toBe(200);
    const data = await res.json() as { pairs: unknown[] };
    expect(Array.isArray(data.pairs)).toBe(true);
  });
});

test.describe('ATDI & Debt', () => {
  test.beforeAll(async ({ request }) => {
    const reposRes = await request.get('/api/repos');
    const reposData = await reposRes.json() as { repos: string[] };
    firstRepo = reposData.repos[0] ?? '';
  });

  test('GET /api/atdi → 200', async ({ request }) => {
    const res = await request.get('/api/atdi');
    expect(res.status()).toBe(200);
  });

  test('GET /api/atdi/:repo → 200', async ({ request }) => {
    const res = await request.get(`/api/atdi/${encodeURIComponent(firstRepo)}`);
    expect(res.status()).toBe(200);
  });

  test('GET /api/debt → 200', async ({ request }) => {
    const res = await request.get('/api/debt');
    expect(res.status()).toBe(200);
  });

  test('GET /api/debt/:repo → 200', async ({ request }) => {
    const res = await request.get(`/api/debt/${encodeURIComponent(firstRepo)}`);
    expect(res.status()).toBe(200);
  });
});

test.describe('Cross-Repo', () => {
  test.beforeAll(async ({ request }) => {
    const reposRes = await request.get('/api/repos');
    const reposData = await reposRes.json() as { repos: string[] };
    firstRepo = reposData.repos[0] ?? '';
  });

  test('GET /api/cross-repo-graph → 200, has edges and repoPairs', async ({ request }) => {
    const res = await request.get('/api/cross-repo-graph');
    expect(res.status()).toBe(200);
    const data = await res.json() as { edges: unknown[]; repoPairs: unknown[] };
    expect(Array.isArray(data.edges)).toBe(true);
    expect(Array.isArray(data.repoPairs)).toBe(true);
  });

  test('POST /api/cross-repo-impact with files and repo → 200', async ({ request }) => {
    const res = await request.post('/api/cross-repo-impact', {
      data: { files: ['src/index.ts'], repo: firstRepo },
    });
    expect(res.status()).toBe(200);
  });

  test('POST /api/cross-repo-impact with empty body → 400', async ({ request }) => {
    const res = await request.post('/api/cross-repo-impact', {
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('GET /api/cross-repo-features → 200, has flags key', async ({ request }) => {
    const res = await request.get('/api/cross-repo-features');
    expect(res.status()).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('flags');
  });

  test('GET /api/cross-repo-faults → 200, has faultLinks key', async ({ request }) => {
    const res = await request.get('/api/cross-repo-faults');
    expect(res.status()).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('faultLinks');
  });

  test('GET /api/cross-repo-catalog → 200, has entries key', async ({ request }) => {
    const res = await request.get('/api/cross-repo-catalog');
    expect(res.status()).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('entries');
  });
});

test.describe('Blast Radius', () => {
  test.beforeAll(async ({ request }) => {
    const reposRes = await request.get('/api/repos');
    const reposData = await reposRes.json() as { repos: string[] };
    firstRepo = reposData.repos[0] ?? '';
  });

  test('GET /api/blast-radius/:repo → 200, { repo, files, totalNodes }', async ({ request }) => {
    const res = await request.get(`/api/blast-radius/${encodeURIComponent(firstRepo)}`);
    expect(res.status()).toBe(200);
    const data = await res.json() as { repo: string; files: unknown[]; totalNodes: number };
    expect(typeof data.repo).toBe('string');
    expect(Array.isArray(data.files)).toBe(true);
    expect(typeof data.totalNodes).toBe('number');
  });

  test('GET /api/blast-radius/:repo?file=<path>&maxDepth=2 → 200, changedFiles and affectedFiles', async ({ request }) => {
    // First get overview to find a valid file path
    const overviewRes = await request.get(`/api/blast-radius/${encodeURIComponent(firstRepo)}`);
    const overview = await overviewRes.json() as { files: Array<{ path: string }> };
    const filePath = overview.files[0]?.path;
    if (!filePath) test.skip();

    const res = await request.get(
      `/api/blast-radius/${encodeURIComponent(firstRepo)}?file=${encodeURIComponent(filePath!)}&maxDepth=2`,
    );
    expect(res.status()).toBe(200);
    const data = await res.json() as { changedFiles: unknown[]; affectedFiles: unknown[] };
    expect(Array.isArray(data.changedFiles)).toBe(true);
    expect(Array.isArray(data.affectedFiles)).toBe(true);
  });
});
