import { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchCrossEntityDeps, fetchRepos, type CrossEntityDep } from '../api/client.ts';
import { EmptyState } from '../components/shared/EmptyState.tsx';

export default function CrossEntityView() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [repos, setRepos] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [deps, setDeps] = useState<CrossEntityDep[]>([]);
  const [stats, setStats] = useState<{ totalAccesses: number; crossEntityAccesses: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessedDomainFilter, setAccessedDomainFilter] = useState(searchParams.get('accessedDomain') ?? '');
  const [guardDomainFilter, setGuardDomainFilter] = useState(searchParams.get('guardDomain') ?? '');

  useEffect(() => {
    fetchRepos({ indexed: true })
      .then(({ repos: repoList }) => {
        setRepos(repoList);
        if (repoList.length > 0) setSelectedRepo(repoList[0]);
      })
      .catch(() => setRepos([]));
  }, []);

  useEffect(() => {
    if (!selectedRepo) return;
    setLoading(true);
    fetchCrossEntityDeps(selectedRepo)
      .then(({ dependencies, stats: s }) => {
        setDeps(dependencies);
        setStats(s);
      })
      .catch(() => { setDeps([]); setStats(null); })
      .finally(() => setLoading(false));
  }, [selectedRepo]);

  const domains = useMemo(() => {
    const set = new Set<string>();
    for (const d of deps) {
      set.add(d.accessedDomain);
      set.add(d.guard.domain);
    }
    return Array.from(set).sort();
  }, [deps]);

  const filtered = useMemo(() => {
    let result = deps;
    if (accessedDomainFilter) result = result.filter((d) => d.accessedDomain === accessedDomainFilter);
    if (guardDomainFilter) result = result.filter((d) => d.guard.domain === guardDomainFilter);
    return result;
  }, [deps, accessedDomainFilter, guardDomainFilter]);

  function handleAccessedDomainChange(v: string) {
    setAccessedDomainFilter(v);
    const p = new URLSearchParams(searchParams);
    if (v) p.set('accessedDomain', v); else p.delete('accessedDomain');
    setSearchParams(p);
  }

  function handleGuardDomainChange(v: string) {
    setGuardDomainFilter(v);
    const p = new URLSearchParams(searchParams);
    if (v) p.set('guardDomain', v); else p.delete('guardDomain');
    setSearchParams(p);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-slate-100">Cross-Entity Dependencies</h1>
        <select
          value={selectedRepo}
          onChange={(e) => setSelectedRepo(e.target.value)}
          className="bg-slate-700 text-slate-200 rounded px-3 py-2 text-sm border border-slate-600"
        >
          {repos.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-4 sm:w-fit">
          <div className="bg-slate-800 rounded-lg p-4">
            <div className="text-2xl font-bold text-slate-100">{stats.totalAccesses}</div>
            <div className="text-sm text-slate-400 mt-0.5">Total Accesses</div>
          </div>
          <div className="bg-slate-800 rounded-lg p-4">
            <div className="text-2xl font-bold text-amber-400">{stats.crossEntityAccesses}</div>
            <div className="text-sm text-slate-400 mt-0.5">Cross-Entity</div>
          </div>
        </div>
      )}

      <div className="flex gap-4 flex-wrap">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Accessed Domain</label>
          <select
            value={accessedDomainFilter}
            onChange={(e) => handleAccessedDomainChange(e.target.value)}
            className="bg-slate-700 text-slate-200 rounded px-3 py-1.5 text-sm border border-slate-600"
          >
            <option value="">All</option>
            {domains.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Guard Domain</label>
          <select
            value={guardDomainFilter}
            onChange={(e) => handleGuardDomainChange(e.target.value)}
            className="bg-slate-700 text-slate-200 rounded px-3 py-1.5 text-sm border border-slate-600"
          >
            <option value="">All</option>
            {domains.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-slate-400">Loading...</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="search"
          title="No cross-entity dependencies found"
          description="Dependencies between config domains will appear here after indexing."
        />
      ) : (
        <div className="bg-slate-800 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="text-xs text-slate-400 uppercase border-b border-slate-700">
                  <th className="px-4 py-3">Accessed Domain</th>
                  <th className="px-4 py-3">Field</th>
                  <th className="px-4 py-3">Integrator Type</th>
                  <th className="px-4 py-3">Guard Domain</th>
                  <th className="px-4 py-3">Guard Condition</th>
                  <th className="px-4 py-3">Evidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {filtered.map((d, i) => (
                  <tr key={i} className="hover:bg-slate-700/30">
                    <td className="px-4 py-3 text-xs text-slate-300">{d.accessedDomain}</td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-200">{d.accessedField}</td>
                    <td className="px-4 py-3 text-xs text-slate-400 font-mono">{d.integratorType ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-slate-300">{d.guard.domain}</td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-400">
                      {d.guard.negated ? '!' : ''}{d.guard.field} {d.guard.operator}{d.guard.value !== undefined ? ` ${d.guard.value}` : ''}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {d.evidence.length > 0
                        ? `${d.evidence[0]!.file.split('/').pop()}:${d.evidence[0]!.line}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
