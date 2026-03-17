const BASE = '';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText} (${url})`);
  }
  return res.json() as Promise<T>;
}

export async function fetchRepos(): Promise<{ repos: string[] }> {
  return fetchJson(`${BASE}/api/repos`);
}

export async function fetchMetrics(repo: string): Promise<unknown[]> {
  return fetchJson(`${BASE}/api/metrics/${encodeURIComponent(repo)}`);
}

export async function fetchMetricsSummary(): Promise<Record<string, unknown>> {
  return fetchJson(`${BASE}/api/metrics-summary`);
}

export async function fetchFindings(
  params: Record<string, string> | URLSearchParams,
): Promise<{ results: unknown[]; total: number }> {
  const qs = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  return fetchJson(`${BASE}/api/findings?${qs}`);
}

export async function fetchFindingsByRule(
  ruleId: string,
): Promise<{ results: unknown[]; total: number }> {
  return fetchJson(`${BASE}/api/findings/${encodeURIComponent(ruleId)}`);
}

export async function fetchGraph(
  repo: string,
  kind?: string,
): Promise<{ edges: unknown[] }> {
  const url = `${BASE}/api/graph/${encodeURIComponent(repo)}${kind ? `?kind=${kind}` : ''}`;
  return fetchJson(url);
}

export async function fetchDependencies(
  module: string,
  depth?: number,
): Promise<unknown> {
  const qs = depth ? `?depth=${depth}` : '';
  return fetchJson(
    `${BASE}/api/dependencies/${encodeURIComponent(module)}${qs}`,
  );
}

export async function fetchPractices(): Promise<unknown> {
  return fetchJson(`${BASE}/api/practices`);
}

export async function fetchPatterns(repo: string): Promise<unknown> {
  return fetchJson(`${BASE}/api/patterns/${encodeURIComponent(repo)}`);
}

export async function fetchHotspots(): Promise<unknown[]> {
  return fetchJson(`${BASE}/api/hotspots`);
}

export interface ModuleMetric {
  module: string;
  repo: string;
  ca: number;
  ce: number;
  instability: number;
  abstractness: number;
  distance: number;
  zone: string;
}

export async function fetchAllMetrics(): Promise<ModuleMetric[]> {
  return fetchJson(`${BASE}/api/metrics-all`);
}

export interface DsmData {
  modules: string[];
  matrix: number[][];
  edgeKind: string;
}

export async function fetchDsm(repo: string, kind?: string): Promise<DsmData> {
  const qs = kind ? `?kind=${kind}` : '';
  return fetchJson(`${BASE}/api/dsm/${encodeURIComponent(repo)}${qs}`);
}

export interface AtdiRepoScore {
  repo: string;
  score: number;
  moduleCount: number;
  components: {
    findingsDensity: number;
    zoneRatio: number;
    avgDistance: number;
  };
  findingCounts: {
    error: number;
    warning: number;
    note: number;
  };
}

export interface SystemAtdi {
  score: number;
  repoScores: AtdiRepoScore[];
  computedAt: string;
}

export async function fetchAtdi(): Promise<SystemAtdi | null> {
  return fetchJson<SystemAtdi>(`${BASE}/api/atdi`).catch(() => null);
}

export interface CrossRepoEdge {
  edge: { source: string; target: string; kind: string };
  sourceRepo: string;
  targetRepo: string;
  packageName: string;
}

export interface CrossRepoGraphData {
  edges: CrossRepoEdge[];
  repoPairs: string[];
  downstreamMap: [string, string[]][];
  upstreamMap: [string, string[]][];
}

export async function fetchCrossRepoGraph(repo?: string): Promise<CrossRepoGraphData> {
  const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
  return fetchJson(`${BASE}/api/cross-repo-graph${qs}`);
}

export interface CoupledPairRow {
  fileA: string;
  fileB: string;
  coChangeCount: number;
  supportA: number;
  supportB: number;
  confidence: number;
  repo: string;
}

export async function fetchTemporalCoupling(): Promise<CoupledPairRow[]> {
  return fetchJson(`${BASE}/api/temporal-coupling`);
}

export interface RepoTemporalCoupling {
  pairs: CoupledPairRow[];
  commitsAnalyzed: number;
  commitsSkipped: number;
}

export async function fetchTemporalCouplingByRepo(repo: string): Promise<RepoTemporalCoupling> {
  return fetchJson(`${BASE}/api/temporal-coupling/${encodeURIComponent(repo)}`);
}

export async function fetchAtdiByRepo(repo: string): Promise<AtdiRepoScore | null> {
  return fetchJson<AtdiRepoScore>(`${BASE}/api/atdi/${encodeURIComponent(repo)}`).catch(() => null);
}

export interface RepoDebtSummary {
  repo: string;
  totalMinutes: number;
  totalHours: number;
  byRule: Record<string, { count: number; minutes: number }>;
  bySeverity: Record<string, { count: number; minutes: number }>;
}

export async function fetchDebtByRepo(repo: string): Promise<RepoDebtSummary | null> {
  return fetchJson<RepoDebtSummary>(`${BASE}/api/debt/${encodeURIComponent(repo)}`).catch(() => null);
}
