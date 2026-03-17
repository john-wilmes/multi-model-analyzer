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
