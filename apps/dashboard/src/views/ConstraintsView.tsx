import { useEffect, useState, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchConstraints, fetchRepos, type ConfigDomain, type ConstraintSetSummary } from '../api/client.ts';
import { EmptyState } from '../components/shared/EmptyState.tsx';

const DOMAINS: { value: ConfigDomain; label: string }[] = [
  { value: 'credentials', label: 'Credentials' },
  { value: 'integrator-settings', label: 'Integrator Settings' },
  { value: 'account-settings', label: 'Account Settings' },
];

export default function ConstraintsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const domainParam = (searchParams.get('domain') ?? 'credentials') as ConfigDomain;

  const [repos, setRepos] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [domain, setDomain] = useState<ConfigDomain>(domainParam);
  const [constraintSets, setConstraintSets] = useState<ConstraintSetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetchRepos({ indexed: true })
      .then(({ repos: repoList }) => {
        setRepos(repoList);
        if (repoList.length > 0) {
          setSelectedRepo(repoList[0]);
        }
      })
      .catch(() => setRepos([]));
  }, []);

  useEffect(() => {
    if (!selectedRepo) return;
    setLoading(true);
    setConstraintSets([]);
    fetchConstraints(domain, selectedRepo)
      .then(({ constraintSets: sets }) => setConstraintSets(sets))
      .catch(() => setConstraintSets([]))
      .finally(() => setLoading(false));
  }, [selectedRepo, domain]);

  function handleDomainChange(d: ConfigDomain) {
    setDomain(d);
    setSearchParams({ domain: d });
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return constraintSets;
    const q = search.toLowerCase();
    return constraintSets.filter((s) => s.integratorType.toLowerCase().includes(q));
  }, [constraintSets, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => a.integratorType.localeCompare(b.integratorType));
  }, [filtered]);

  const totalFields = useMemo(() => constraintSets.reduce((n, s) => n + s.fieldCount, 0), [constraintSets]);
  const totalAlways = useMemo(() => constraintSets.reduce((n, s) => n + s.always, 0), [constraintSets]);
  const totalConditional = useMemo(() => constraintSets.reduce((n, s) => n + s.conditional, 0), [constraintSets]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-slate-100">Config Constraints</h1>
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

      <div className="flex gap-1 bg-slate-800 rounded-lg p-1 w-fit">
        {DOMAINS.map((d) => (
          <button
            key={d.value}
            onClick={() => handleDomainChange(d.value)}
            className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
              domain === d.value ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12 text-slate-400">Loading...</div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="bg-slate-800 rounded-lg p-4">
              <div className="text-2xl font-bold text-slate-100">{constraintSets.length}</div>
              <div className="text-sm text-slate-400 mt-0.5">Constraint Sets</div>
            </div>
            <div className="bg-slate-800 rounded-lg p-4">
              <div className="text-2xl font-bold text-slate-100">{totalFields}</div>
              <div className="text-sm text-slate-400 mt-0.5">Total Fields</div>
            </div>
            <div className="bg-slate-800 rounded-lg p-4">
              <div className="text-2xl font-bold text-emerald-400">{totalAlways}</div>
              <div className="text-sm text-slate-400 mt-0.5">Always Required</div>
            </div>
            <div className="bg-slate-800 rounded-lg p-4">
              <div className="text-2xl font-bold text-amber-400">{totalConditional}</div>
              <div className="text-sm text-slate-400 mt-0.5">Conditional</div>
            </div>
          </div>

          <div>
            <input
              type="text"
              placeholder="Filter by integrator type..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-slate-700 text-slate-200 rounded px-3 py-2 text-sm border border-slate-600 focus:border-blue-500 focus:outline-none w-full max-w-sm"
            />
          </div>

          {sorted.length === 0 ? (
            <EmptyState
              icon="search"
              title="No constraint sets found"
              description={
                search
                  ? `No integrator types match "${search}".`
                  : 'No constraint data available for this domain.'
              }
            />
          ) : (
            <div className="bg-slate-800 rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="text-xs text-slate-400 uppercase border-b border-slate-700">
                      <th className="px-4 py-3">Integrator Type</th>
                      <th className="px-4 py-3 text-right">Fields</th>
                      <th className="px-4 py-3 text-right">Always Required</th>
                      <th className="px-4 py-3 text-right">Conditional</th>
                      <th className="px-4 py-3 text-right">Never Required</th>
                      <th className="px-4 py-3 text-right">Coverage</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/50">
                    {sorted.map((s) => {
                      const { totalAccesses, resolvedAccesses } = s.coverage;
                      const coveragePct =
                        totalAccesses > 0
                          ? Math.round((resolvedAccesses / totalAccesses) * 100)
                          : 0;
                      return (
                        <tr key={s.integratorType} className="hover:bg-slate-700/30">
                          <td className="px-4 py-3">
                            <Link
                              to={`/constraints/${encodeURIComponent(s.integratorType)}?domain=${domain}`}
                              className="text-blue-400 hover:text-blue-300 font-mono text-xs"
                            >
                              {s.integratorType}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-right text-slate-300">{s.fieldCount}</td>
                          <td className="px-4 py-3 text-right">
                            <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-900/30 text-emerald-400">
                              {s.always}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-900/30 text-amber-400">
                              {s.conditional}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-700 text-slate-300">
                              {s.never}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span
                              className={`px-2 py-0.5 rounded text-xs font-medium ${
                                coveragePct >= 80
                                  ? 'bg-emerald-900/30 text-emerald-400'
                                  : coveragePct >= 50
                                  ? 'bg-amber-900/30 text-amber-400'
                                  : 'bg-red-900/30 text-red-400'
                              }`}
                            >
                              {coveragePct}%
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
