import { useEffect, useState, useMemo } from 'react';
import { fetchCrossRepoFeatures } from '../api/client.ts';
import type { SharedFlag } from '../api/client.ts';

type SortKey = 'name' | 'repoCount' | 'coordinated';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 25;

interface Props {
  repo?: string;
}

export default function FeatureFlagsTable({ repo }: Props) {
  const [flags, setFlags] = useState<SharedFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);

  useEffect(() => {
    setLoading(true);
    setPage(0);
    fetchCrossRepoFeatures(repo)
      .then((data) => setFlags(Array.isArray(data?.flags) ? data.flags : []))
      .catch(() => setFlags([]))
      .finally(() => setLoading(false));
  }, [repo]);

  const sorted = useMemo(() => {
    const arr = [...flags];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortKey === 'repoCount') cmp = a.repos.length - b.repos.length;
      else if (sortKey === 'coordinated') cmp = (a.coordinated ? 1 : 0) - (b.coordinated ? 1 : 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [flags, sortKey, sortDir]);

  const paged = useMemo(() => {
    return sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  }, [sorted, page]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  function SortIndicator({ k }: { k: SortKey }) {
    if (sortKey !== k) return <span className="ml-1 text-slate-300">↕</span>;
    return <span className="ml-1">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  }

  const coordinated = flags.filter((f) => f.coordinated).length;
  const uncoordinated = flags.length - coordinated;
  const start = page * PAGE_SIZE + 1;
  const end = Math.min((page + 1) * PAGE_SIZE, sorted.length);

  if (loading) return (
    <div className="p-8 text-center text-slate-500 dark:text-slate-400 animate-pulse">
      <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-48 mx-auto mb-2" />
      <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-32 mx-auto" />
    </div>
  );

  if (flags.length === 0) {
    return <p className="text-slate-500 dark:text-slate-400 text-center py-12">No shared feature flags detected across repos. Feature flags shared across 2+ repos will appear here.</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Shared Feature Flags</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {flags.length} shared flags ({coordinated} coordinated, {uncoordinated} uncoordinated)
        </p>
      </div>
      <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
            <tr>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('name')}
              >
                Flag Name<SortIndicator k="name" />
              </th>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('repoCount')}
              >
                Repos<SortIndicator k="repoCount" />
              </th>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('coordinated')}
              >
                Status<SortIndicator k="coordinated" />
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.map((f, i) => (
              <tr key={f.name} className={i % 2 === 0 ? 'bg-white dark:bg-slate-800' : 'bg-slate-50 dark:bg-slate-900/50'}>
                <td className="px-3 py-1.5 font-mono text-xs text-slate-700 dark:text-slate-300">{f.name}</td>
                <td className="px-3 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {f.repos.map((r) => (
                      <span key={r} className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                        {r}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-1.5">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    f.coordinated
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                  }`}>
                    {f.coordinated ? 'Coordinated' : 'Uncoordinated'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {sorted.length > PAGE_SIZE && (
          <div className="px-4 py-3 border-t dark:border-slate-700 flex items-center justify-between text-sm text-slate-600 dark:text-slate-400">
            <span>{start}–{end} of {sorted.length}</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => p - 1)}
                disabled={page === 0}
                className="px-3 py-1 rounded border dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Prev
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={end >= sorted.length}
                className="px-3 py-1 rounded border dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
      <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
        Flags appearing in 2+ repos. Uncoordinated flags have no dependency edge between sharing repos.
      </p>
    </div>
  );
}
