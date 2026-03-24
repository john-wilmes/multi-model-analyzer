import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { fetchHotspots, fetchRepos } from '../api/client.ts';
import { EmptyState } from '../components/shared/EmptyState.tsx';

interface HotspotEntry {
  repo: string;
  filePath: string;
  churn: number;
  symbolCount: number;
  hotspotScore: number;
}

type SortKey = 'filePath' | 'repo' | 'churn' | 'symbolCount' | 'hotspotScore';

function scoreBarColor(score: number): string {
  if (score > 70) return 'bg-red-500';
  if (score > 40) return 'bg-yellow-500';
  return 'bg-green-500';
}

function scoreTextColor(score: number): string {
  if (score > 70) return 'text-red-700 dark:text-red-400';
  if (score > 40) return 'text-yellow-700 dark:text-yellow-400';
  return 'text-green-700 dark:text-green-400';
}

export default function HotspotsView() {
  const [hotspots, setHotspots] = useState<HotspotEntry[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('hotspotScore');
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    Promise.all([fetchHotspots(), fetchRepos()])
      .then(([data, repoData]) => {
        setHotspots((data as HotspotEntry[]) ?? []);
        setRepos(repoData.repos);
      })
      .catch(() => {
        setHotspots([]);
        setRepos([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const repoCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of hotspots) {
      counts.set(h.repo, (counts.get(h.repo) ?? 0) + 1);
    }
    return counts;
  }, [hotspots]);

  const filtered = useMemo(() => {
    const base = selectedRepo ? hotspots.filter((h) => h.repo === selectedRepo) : hotspots;
    return [...base].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [hotspots, selectedRepo, sortKey, sortAsc]);

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  }

  function arrow(key: SortKey) {
    if (key !== sortKey) return '';
    return sortAsc ? ' \u25B2' : ' \u25BC';
  }

  if (loading) return (
    <div className="p-8 text-center animate-pulse">
      <div className="h-6 bg-slate-200 dark:bg-slate-700 rounded w-48 mx-auto mb-4" />
      <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-700">
        <div className="h-8 bg-slate-100 dark:bg-slate-800 border-b dark:border-slate-700" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-7 bg-white dark:bg-slate-800 border-b dark:border-slate-700 last:border-0" />
        ))}
      </div>
    </div>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Hotspot Analysis</h1>
          <span className="text-xs font-semibold bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded-full">
            {filtered.length}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200"
          >
            <option value="">All repos ({hotspots.length} files)</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r} ({repoCounts.get(r) ?? 0})
              </option>
            ))}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon="search"
          title={`No hotspots found${selectedRepo ? ` for ${selectedRepo}` : ''}`}
          description="Files with high churn and many symbols will appear here after indexing."
        />
      ) : (
        <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th
                  className="text-left px-3 py-2 cursor-pointer select-none text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  onClick={() => handleSort('filePath')}
                >
                  File Path{arrow('filePath')}
                </th>
                {!selectedRepo && (
                  <th
                    className="text-left px-3 py-2 cursor-pointer select-none text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    onClick={() => handleSort('repo')}
                  >
                    Repo{arrow('repo')}
                  </th>
                )}
                <th
                  className="text-right px-3 py-2 cursor-pointer select-none text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  onClick={() => handleSort('churn')}
                >
                  Churn (commits){arrow('churn')}
                </th>
                <th
                  className="text-right px-3 py-2 cursor-pointer select-none text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  onClick={() => handleSort('symbolCount')}
                >
                  Symbols{arrow('symbolCount')}
                </th>
                <th
                  className="text-left px-3 py-2 cursor-pointer select-none text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 min-w-[160px]"
                  onClick={() => handleSort('hotspotScore')}
                >
                  Hotspot Score{arrow('hotspotScore')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((h, i) => {
                const encodedRepo = encodeURIComponent(h.repo);
                const encodedPath = h.filePath.split('/').map(encodeURIComponent).join('/');
                return (
                  <tr
                    key={`${h.repo}-${h.filePath}`}
                    className={i % 2 === 0 ? 'bg-white dark:bg-slate-800' : 'bg-slate-50 dark:bg-slate-900/50'}
                  >
                    <td className="px-3 py-1.5 font-mono text-xs truncate max-w-xs text-slate-700 dark:text-slate-300" title={h.filePath}>
                      <Link
                        to={`/repo/${encodedRepo}/module/${encodedPath}`}
                        className="hover:underline text-blue-600 dark:text-blue-400"
                      >
                        {h.filePath}
                      </Link>
                    </td>
                    {!selectedRepo && (
                      <td className="px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">{h.repo}</td>
                    )}
                    <td className="px-3 py-1.5 text-right font-semibold text-slate-800 dark:text-slate-200">{h.churn}</td>
                    <td className="px-3 py-1.5 text-right text-slate-600 dark:text-slate-400">{h.symbolCount}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-slate-200 dark:bg-slate-700 rounded-full h-1.5 min-w-[80px]">
                          <div
                            className={`h-1.5 rounded-full ${scoreBarColor(h.hotspotScore)}`}
                            style={{ width: `${Math.min(h.hotspotScore, 100)}%` }}
                          />
                        </div>
                        <span className={`text-xs font-semibold w-8 text-right ${scoreTextColor(h.hotspotScore)}`}>
                          {h.hotspotScore.toFixed(0)}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
        Hotspot score combines commit churn with symbol density. Score &gt; 70 (red) indicates high-risk files.
      </p>
    </div>
  );
}
