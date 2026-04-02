import { useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { fetchConstraintDetail, type ConstraintSetDetail, type FieldConstraintInfo, type ConfigDomain } from '../api/client.ts';
import { EmptyState } from '../components/shared/EmptyState.tsx';

function requiredBadge(level: FieldConstraintInfo['required']) {
  if (level === 'always') return <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-900/30 text-emerald-400">always</span>;
  if (level === 'conditional') return <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-900/30 text-amber-400">conditional</span>;
  return <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-700 text-slate-300">never</span>;
}

export default function ConstraintDetailView() {
  const { type } = useParams<{ type: string }>();
  const [searchParams] = useSearchParams();
  const domain = (searchParams.get('domain') ?? 'credentials') as ConfigDomain;
  const repo = searchParams.get('repo') ?? undefined;

  const [detail, setDetail] = useState<ConstraintSetDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'' | 'always' | 'conditional' | 'never'>('');

  useEffect(() => {
    if (!type) return;
    setLoading(true);
    setError(null);
    fetchConstraintDetail(type, domain, repo)
      .then((d) => setDetail(d))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [type, domain, repo]);

  if (loading) return <div className="text-center py-12 text-slate-400">Loading...</div>;
  if (error) return <div className="text-center py-12 text-red-400">{error}</div>;
  if (!detail) return <EmptyState icon="search" title="Not found" description="Constraint set not found." />;

  const fields = filter ? detail.fields.filter((f) => f.required === filter) : detail.fields;
  const { totalAccesses, resolvedAccesses } = detail.coverage;
  const coveragePct = totalAccesses > 0 ? Math.round((resolvedAccesses / totalAccesses) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Link to={`/constraints?domain=${domain}`} className="text-slate-400 hover:text-slate-200 text-sm">
          &larr; Back
        </Link>
        <h1 className="text-2xl font-bold text-slate-100 font-mono">{detail.integratorType}</h1>
        <span className="text-xs text-slate-400 bg-slate-800 px-2 py-0.5 rounded">{domain}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-slate-800 rounded-lg p-4">
          <div className="text-2xl font-bold text-slate-100">{detail.fields.length}</div>
          <div className="text-sm text-slate-400 mt-0.5">Total Fields</div>
        </div>
        <div className="bg-slate-800 rounded-lg p-4">
          <div className="text-2xl font-bold text-emerald-400">{detail.fields.filter((f) => f.required === 'always').length}</div>
          <div className="text-sm text-slate-400 mt-0.5">Always Required</div>
        </div>
        <div className="bg-slate-800 rounded-lg p-4">
          <div className="text-2xl font-bold text-amber-400">{detail.fields.filter((f) => f.required === 'conditional').length}</div>
          <div className="text-sm text-slate-400 mt-0.5">Conditional</div>
        </div>
        <div className="bg-slate-800 rounded-lg p-4">
          <div className={`text-2xl font-bold ${coveragePct >= 80 ? 'text-emerald-400' : coveragePct >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
            {coveragePct}%
          </div>
          <div className="text-sm text-slate-400 mt-0.5">Coverage ({resolvedAccesses}/{totalAccesses})</div>
        </div>
      </div>

      <div className="flex gap-1 bg-slate-800 rounded-lg p-1 w-fit">
        {(['', 'always', 'conditional', 'never'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setFilter(v)}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              filter === v ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {v === '' ? 'All' : v}
          </button>
        ))}
      </div>

      {fields.length === 0 ? (
        <EmptyState icon="search" title="No fields match" description="Try a different filter." />
      ) : (
        <div className="bg-slate-800 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="text-xs text-slate-400 uppercase border-b border-slate-700">
                  <th className="px-4 py-3">Field</th>
                  <th className="px-4 py-3">Required</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Default</th>
                  <th className="px-4 py-3">Known Values</th>
                  <th className="px-4 py-3">Evidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {fields.map((f) => (
                  <tr key={f.field} className="hover:bg-slate-700/30">
                    <td className="px-4 py-3 font-mono text-xs text-slate-200">{f.field}</td>
                    <td className="px-4 py-3">{requiredBadge(f.required)}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">{f.inferredType ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-slate-400 font-mono">
                      {f.defaultValue !== undefined ? String(f.defaultValue) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      {f.knownValues && f.knownValues.length > 0
                        ? f.knownValues.slice(0, 5).join(', ') + (f.knownValues.length > 5 ? '…' : '')
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {f.evidence.length > 0
                        ? `${f.evidence[0]!.file.split('/').pop()}:${f.evidence[0]!.line}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {detail.dynamicAccesses.length > 0 && (
        <div className="bg-slate-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-300 mb-2">Dynamic Accesses ({detail.dynamicAccesses.length})</h2>
          <ul className="space-y-1">
            {detail.dynamicAccesses.map((da, i) => (
              <li key={i} className="text-xs text-slate-400 font-mono">
                <span className="text-slate-500">{da.file.split('/').pop()}:{da.line}</span> — {da.pattern}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
