import { useEffect, useState, useMemo } from 'react';
import { fetchTemporalCoupling, fetchRepos } from '../api/client.ts';
import type { CoupledPairRow } from '../api/client.ts';

type SortKey = 'coChangeCount' | 'confidence' | 'fileA' | 'fileB';

export default function TemporalCouplingView() {
  const [pairs, setPairs] = useState<CoupledPairRow[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('coChangeCount');
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    Promise.all([fetchTemporalCoupling(), fetchRepos()])
      .then(([data, repoData]) => {
        setPairs(data);
        setRepos(repoData.repos);
      })
      .catch(() => {
        setPairs([]);
        setRepos([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const base = selectedRepo ? pairs.filter((p) => p.repo === selectedRepo) : pairs;
    const sorted = [...base].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string' && typeof bv === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return sorted;
  }, [pairs, selectedRepo, sortKey, sortAsc]);

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  }

  function arrow(key: SortKey) {
    if (key !== sortKey) return '';
    return sortAsc ? ' \u25B2' : ' \u25BC';
  }

  function confidenceBadge(c: number) {
    if (c >= 0.8) return 'bg-amber-100 text-amber-800';
    return 'bg-slate-100 text-slate-700';
  }

  if (loading) return <div className="p-8 text-center text-slate-500">Loading temporal coupling data...</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Temporal Coupling</h1>
        <select
          value={selectedRepo}
          onChange={(e) => setSelectedRepo(e.target.value)}
          className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white"
        >
          <option value="">All repos ({pairs.length} pairs)</option>
          {repos.map((r) => (
            <option key={r} value={r}>
              {r} ({pairs.filter((p) => p.repo === r).length})
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="text-slate-500 text-center py-12">No temporal coupling detected.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-3 py-2 cursor-pointer select-none" onClick={() => handleSort('fileA')}>
                  File A{arrow('fileA')}
                </th>
                <th className="text-left px-3 py-2 cursor-pointer select-none" onClick={() => handleSort('fileB')}>
                  File B{arrow('fileB')}
                </th>
                <th className="text-right px-3 py-2 cursor-pointer select-none" onClick={() => handleSort('coChangeCount')}>
                  Co-changes{arrow('coChangeCount')}
                </th>
                <th className="text-right px-3 py-2 cursor-pointer select-none" onClick={() => handleSort('confidence')}>
                  Confidence{arrow('confidence')}
                </th>
                <th className="text-right px-3 py-2">Support A</th>
                <th className="text-right px-3 py-2">Support B</th>
                {!selectedRepo && <th className="text-left px-3 py-2">Repo</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => (
                <tr key={`${p.repo}-${p.fileA}-${p.fileB}`} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                  <td className="px-3 py-1.5 font-mono text-xs truncate max-w-xs" title={p.fileA}>{p.fileA}</td>
                  <td className="px-3 py-1.5 font-mono text-xs truncate max-w-xs" title={p.fileB}>{p.fileB}</td>
                  <td className="px-3 py-1.5 text-right font-semibold">{p.coChangeCount}</td>
                  <td className="px-3 py-1.5 text-right">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${confidenceBadge(p.confidence)}`}>
                      {(p.confidence * 100).toFixed(0)}%
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right text-slate-600">{(p.supportA * 100).toFixed(0)}%</td>
                  <td className="px-3 py-1.5 text-right text-slate-600">{(p.supportB * 100).toFixed(0)}%</td>
                  {!selectedRepo && <td className="px-3 py-1.5 text-xs text-slate-500">{p.repo}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-slate-400">
        Pairs sorted by {sortKey}. Confidence &ge; 80% highlighted as warnings.
      </p>
    </div>
  );
}
