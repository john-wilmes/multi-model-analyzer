import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchFindings, fetchRepos } from '../api/client.ts';

interface Finding {
  ruleId?: string;
  level?: string;
  message?: string;
  location?: string;
  repo?: string;
}

const PAGE_SIZE = 25;

const SEVERITY_LEVELS = ['error', 'warning', 'note'] as const;

const BADGE_CLASSES: Record<string, string> = {
  error: 'bg-red-100 text-red-700',
  warning: 'bg-yellow-100 text-yellow-700',
  note: 'bg-blue-100 text-blue-700',
};

function SeverityBadge({ level }: { level?: string }) {
  const cls = BADGE_CLASSES[level ?? ''] ?? 'bg-slate-100 text-slate-600';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {level ?? 'note'}
    </span>
  );
}

export default function FindingsTable() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [repos, setRepos] = useState<string[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const repo = searchParams.get('repo') ?? '';
  const severities = searchParams.getAll('severity');
  const rule = searchParams.get('rule') ?? '';
  const page = parseInt(searchParams.get('page') ?? '0', 10);

  const [ruleInput, setRuleInput] = useState(rule);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    debounceRef.current = setTimeout(() => setParam('rule', ruleInput), 300);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleInput]);

  const load = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    qs.set('offset', String(page * PAGE_SIZE));
    qs.set('limit', String(PAGE_SIZE));
    if (repo) qs.set('repo', repo);
    if (rule) qs.set('rule', rule);
    severities.forEach((s) => qs.append('level', s));

    fetchFindings(qs)
      .then((data) => {
        setFindings((data.results ?? []) as Finding[]);
        setTotal(data.total ?? 0);
      })
      .catch((err: unknown) => console.error("Failed to fetch findings:", err))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, rule, page, severities.join(',')]);

  useEffect(() => {
    fetchRepos()
      .then((d) => setRepos(d.repos))
      .catch((err: unknown) => console.error("Failed to fetch repos:", err));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setSearchParams(next);
  }

  function toggleSeverity(level: string) {
    const next = new URLSearchParams(searchParams);
    const current = next.getAll('severity');
    if (current.includes(level)) {
      next.delete('severity');
      current
        .filter((s) => s !== level)
        .forEach((s) => next.append('severity', s));
    } else {
      next.append('severity', level);
    }
    next.delete('page');
    setSearchParams(next);
  }

  function setPage(p: number) {
    const next = new URLSearchParams(searchParams);
    if (p === 0) next.delete('page');
    else next.set('page', String(p));
    setSearchParams(next);
  }

  const start = page * PAGE_SIZE + 1;
  const end = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-800">Findings</h2>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm border p-4 flex flex-wrap gap-4 items-end">
        {/* Repo filter */}
        <div>
          <label className="block text-xs text-slate-500 mb-1">Repo</label>
          <select
            value={repo}
            onChange={(e) => setParam('repo', e.target.value)}
            className="border rounded px-2 py-1 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All repos</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        {/* Severity checkboxes */}
        <div>
          <p className="text-xs text-slate-500 mb-1">Severity</p>
          <div className="flex gap-3">
            {SEVERITY_LEVELS.map((level) => (
              <label key={level} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={severities.includes(level)}
                  onChange={() => toggleSeverity(level)}
                  className="rounded"
                />
                <SeverityBadge level={level} />
              </label>
            ))}
          </div>
        </div>

        {/* Rule filter */}
        <div>
          <label className="block text-xs text-slate-500 mb-1">Rule ID</label>
          <input
            type="text"
            value={ruleInput}
            onChange={(e) => setRuleInput(e.target.value)}
            placeholder="e.g. MMA001"
            className="border rounded px-2 py-1 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-36"
          />
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
        {loading ? (
          <p className="p-4 text-slate-500 text-sm">Loading...</p>
        ) : findings.length === 0 ? (
          <p className="p-4 text-slate-500 text-sm">No findings found.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b">
              <tr className="text-left text-xs text-slate-500">
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Rule ID</th>
                <th className="px-4 py-3">Message</th>
                <th className="px-4 py-3">Location</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <SeverityBadge level={f.level} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600 whitespace-nowrap">
                    {f.ruleId ?? '-'}
                  </td>
                  <td className="px-4 py-3 text-slate-700 max-w-sm truncate">
                    {typeof f.message === 'object' && f.message !== null ? (f.message as { text?: string }).text ?? '-' : f.message ?? '-'}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs font-mono max-w-xs truncate">
                    {(f as any)?.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName ?? '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Pagination */}
        {total > 0 && (
          <div className="px-4 py-3 border-t flex items-center justify-between text-sm text-slate-600">
            <span>
              {start}–{end} of {total}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(page - 1)}
                disabled={page === 0}
                className="px-3 py-1 rounded border hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Prev
              </button>
              <button
                onClick={() => setPage(page + 1)}
                disabled={end >= total}
                className="px-3 py-1 rounded border hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
