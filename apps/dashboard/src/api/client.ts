const BASE = '';

export async function fetchRepos(): Promise<{ repos: string[] }> {
  const res = await fetch(`${BASE}/api/repos`);
  return res.json();
}

export async function fetchMetrics(repo: string): Promise<unknown[]> {
  const res = await fetch(`${BASE}/api/metrics/${encodeURIComponent(repo)}`);
  return res.json();
}

export async function fetchMetricsSummary(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/api/metrics-summary`);
  return res.json();
}

export async function fetchFindings(
  params: Record<string, string>,
): Promise<{ results: unknown[]; total: number }> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${BASE}/api/findings?${qs}`);
  return res.json();
}

export async function fetchFindingsByRule(
  ruleId: string,
): Promise<{ results: unknown[]; total: number }> {
  const res = await fetch(`${BASE}/api/findings/${encodeURIComponent(ruleId)}`);
  return res.json();
}

export async function fetchGraph(
  repo: string,
  kind?: string,
): Promise<{ edges: unknown[] }> {
  const url = `${BASE}/api/graph/${encodeURIComponent(repo)}${kind ? `?kind=${kind}` : ''}`;
  const res = await fetch(url);
  return res.json();
}

export async function fetchDependencies(
  module: string,
  depth?: number,
): Promise<unknown> {
  const qs = depth ? `?depth=${depth}` : '';
  const res = await fetch(
    `${BASE}/api/dependencies/${encodeURIComponent(module)}${qs}`,
  );
  return res.json();
}

export async function fetchPractices(): Promise<unknown> {
  const res = await fetch(`${BASE}/api/practices`);
  return res.json();
}

export async function fetchPatterns(repo: string): Promise<unknown> {
  const res = await fetch(`${BASE}/api/patterns/${encodeURIComponent(repo)}`);
  return res.json();
}
