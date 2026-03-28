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
  const data = await fetchJson<{ results: unknown[] }>(`${BASE}/api/hotspots`);
  return data.results ?? [];
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

export interface ResolvedSymbol {
  name: string;
  targetFileId: string;
  kind: string;
}

export interface CrossRepoEdge {
  edge: {
    source: string;
    target: string;
    kind: string;
    metadata?: {
      importedNames?: string[];
      resolvedSymbols?: ResolvedSymbol[];
    };
  };
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

export interface PaginationParams {
  limit?: number;
  offset?: number;
  search?: string;
}

export async function fetchCrossRepoGraph(repo?: string, pagination?: PaginationParams): Promise<CrossRepoGraphData & { total: number; limit: number; offset: number }> {
  const params = new URLSearchParams();
  if (repo) params.set('repo', repo);
  if (pagination?.limit !== undefined) params.set('limit', String(pagination.limit));
  if (pagination?.offset !== undefined) params.set('offset', String(pagination.offset));
  const qs = params.toString();
  return fetchJson(`${BASE}/api/cross-repo-graph${qs ? `?${qs}` : ''}`);
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

// -- Cross-Repo Model Types --

export interface SharedFlag {
  name: string;
  repos: string[];
  coordinated: boolean;
}

export interface CrossRepoFaultLink {
  endpoint: string;
  sourceRepo: string;
  targetRepo: string;
  sourceFaultTreeCount: number;
  targetFaultTreeCount: number;
}

export interface SystemCatalogEntry {
  entry: {
    name: string;
    purpose: string;
    dependencies: string[];
    apiSurface: { method: string; path: string }[];
    errorHandlingSummary: string;
  };
  repo: string;
  consumers: string[];
  producers: string[];
}

export async function fetchCrossRepoFeatures(repo?: string, pagination?: PaginationParams): Promise<{ flags: SharedFlag[]; total: number; limit: number; offset: number }> {
  const params = new URLSearchParams();
  if (repo) params.set('repo', repo);
  if (pagination?.limit !== undefined) params.set('limit', String(pagination.limit));
  if (pagination?.offset !== undefined) params.set('offset', String(pagination.offset));
  if (pagination?.search) params.set('search', pagination.search);
  const qs = params.toString();
  return fetchJson(`${BASE}/api/cross-repo-features${qs ? `?${qs}` : ''}`);
}

export async function fetchCrossRepoFaults(repo?: string, pagination?: PaginationParams): Promise<{ faultLinks: CrossRepoFaultLink[]; total: number; limit: number; offset: number }> {
  const params = new URLSearchParams();
  if (repo) params.set('repo', repo);
  if (pagination?.limit !== undefined) params.set('limit', String(pagination.limit));
  if (pagination?.offset !== undefined) params.set('offset', String(pagination.offset));
  if (pagination?.search) params.set('search', pagination.search);
  const qs = params.toString();
  return fetchJson(`${BASE}/api/cross-repo-faults${qs ? `?${qs}` : ''}`);
}

export async function fetchCrossRepoCatalog(repo?: string, pagination?: PaginationParams): Promise<{ entries: SystemCatalogEntry[]; total: number; limit: number; offset: number }> {
  const params = new URLSearchParams();
  if (repo) params.set('repo', repo);
  if (pagination?.limit !== undefined) params.set('limit', String(pagination.limit));
  if (pagination?.offset !== undefined) params.set('offset', String(pagination.offset));
  if (pagination?.search) params.set('search', pagination.search);
  const qs = params.toString();
  return fetchJson(`${BASE}/api/cross-repo-catalog${qs ? `?${qs}` : ''}`);
}

// -- Per-Repo Flag Types --

export interface RepoFlag {
  name: string;
  repo: string;
  source: string;
  file?: string;
  line?: number;
}

export async function fetchRepoFlags(repo?: string, search?: string, pagination?: PaginationParams & { excludeSource?: string }): Promise<{ flags: RepoFlag[]; total: number; limit: number; offset: number }> {
  const params = new URLSearchParams();
  if (repo) params.set('repo', repo);
  if (search) params.set('search', search);
  if (pagination?.limit !== undefined) params.set('limit', String(pagination.limit));
  if (pagination?.offset !== undefined) params.set('offset', String(pagination.offset));
  if (pagination?.excludeSource) params.set('excludeSource', pagination.excludeSource);
  const qs = params.toString();
  return fetchJson(`${BASE}/api/repo-flags${qs ? `?${qs}` : ''}`);
}

// -- Repo State Types --

export interface RepoStateInfo {
  name: string;
  url: string;
  status: 'candidate' | 'indexing' | 'indexed' | 'ignored';
  discoveredVia: string;
  discoveredAt: string;
  indexedAt?: string;
  connectionCount: number;
}

export async function fetchRepoStates(): Promise<{ states: RepoStateInfo[] }> {
  return fetchJson(`${BASE}/api/repo-states`);
}

// -- Blast Radius Types --

export interface BlastRadiusOverviewFile {
  path: string;
  score: number;
  rank: number;
  reachCount: number;
}

export interface BlastRadiusOverview {
  repo: string;
  files: BlastRadiusOverviewFile[];
  totalNodes: number;
}

export interface BlastRadiusAffectedFile {
  path: string;
  depth: number;
  via: 'imports' | 'calls' | 'both';
  repo: string;
  score: number;
}

export interface BlastRadiusDetail {
  changedFiles: string[];
  affectedFiles: BlastRadiusAffectedFile[];
  totalAffected: number;
  maxDepth: number;
  description: string;
}

export async function fetchBlastRadiusOverview(repo: string): Promise<BlastRadiusOverview> {
  return fetchJson(`${BASE}/api/blast-radius/${encodeURIComponent(repo)}`);
}

export async function fetchBlastRadius(repo: string, file: string, depth?: number): Promise<BlastRadiusDetail> {
  const params = new URLSearchParams({ file });
  if (depth !== undefined) params.set('maxDepth', String(depth));
  return fetchJson(`${BASE}/api/blast-radius/${encodeURIComponent(repo)}?${params}`);
}
