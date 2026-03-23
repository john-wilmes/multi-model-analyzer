import { useEffect, useState, useMemo } from 'react';
import { fetchCrossRepoFaults } from '../api/client.ts';
import type { CrossRepoFaultLink } from '../api/client.ts';

type SortKey = 'endpoint' | 'sourceRepo' | 'targetRepo' | 'sourceFaults' | 'targetFaults';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 25;

interface Props {
  repo?: string;
}

export default function CascadingFaultsTable({ repo }: Props) {
  const [faultLinks, setFaultLinks] = useState<CrossRepoFaultLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('sourceRepo');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);

  useEffect(() => {
    setLoading(true);
    setPage(0);
    fetchCrossRepoFaults(repo)
      .then((data) => setFaultLinks(Array.isArray(data?.faultLinks) ? data.faultLinks : []))
      .catch(() => setFaultLinks([]))
      .finally(() => setLoading(false));
  }, [repo]);

  const sorted = useMemo(() => {
    const arr = [...faultLinks];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'endpoint') cmp = a.endpoint.localeCompare(b.endpoint);
      else if (sortKey === 'sourceRepo') cmp = a.sourceRepo.localeCompare(b.sourceRepo);
      else if (sortKey === 'targetRepo') cmp = a.targetRepo.localeCompare(b.targetRepo);
      else if (sortKey === 'sourceFaults') cmp = a.sourceFaultTreeCount - b.sourceFaultTreeCount;
      else if (sortKey === 'targetFaults') cmp = a.targetFaultTreeCount - b.targetFaultTreeCount;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [faultLinks, sortKey, sortDir]);

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

  const repoPairs = new Set(faultLinks.map((fl) => `${fl.sourceRepo}→${fl.targetRepo}`)).size;
  const start = page * PAGE_SIZE + 1;
  const end = Math.min((page + 1) * PAGE_SIZE, sorted.length);

  if (loading) return (
    <div className="p-8 text-center animate-pulse">
      <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-48 mx-auto mb-2" />
      <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-32 mx-auto" />
    </div>
  );

  if (faultLinks.length === 0) {
    return <p className="text-slate-500 dark:text-slate-400 text-center py-12">No cascading fault links detected across repos. Fault propagation paths appear when repos share service endpoints with fault trees on both sides.</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Cascading Fault Links</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {faultLinks.length} fault links across {repoPairs} repo pairs
        </p>
      </div>
      <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
            <tr>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('sourceRepo')}
              >
                Source Repo<SortIndicator k="sourceRepo" />
              </th>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('targetRepo')}
              >
                Target Repo<SortIndicator k="targetRepo" />
              </th>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('endpoint')}
              >
                Endpoint<SortIndicator k="endpoint" />
              </th>
              <th
                className="text-right px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('sourceFaults')}
              >
                Source Faults<SortIndicator k="sourceFaults" />
              </th>
              <th
                className="text-right px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('targetFaults')}
              >
                Target Faults<SortIndicator k="targetFaults" />
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.map((fl, i) => (
              <tr key={`${fl.sourceRepo}-${fl.targetRepo}-${fl.endpoint}`} className={i % 2 === 0 ? 'bg-white dark:bg-slate-800' : 'bg-slate-50 dark:bg-slate-900/50'}>
                <td className="px-3 py-1.5">
                  <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">{fl.sourceRepo}</span>
                </td>
                <td className="px-3 py-1.5">
                  <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">{fl.targetRepo}</span>
                </td>
                <td className="px-3 py-1.5 font-mono text-xs text-slate-700 dark:text-slate-300">{fl.endpoint}</td>
                <td className="px-3 py-1.5 text-right font-semibold text-slate-800 dark:text-slate-200">{fl.sourceFaultTreeCount}</td>
                <td className="px-3 py-1.5 text-right font-semibold text-slate-800 dark:text-slate-200">{fl.targetFaultTreeCount}</td>
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
        Fault propagation paths between repos connected by service endpoints.
      </p>
    </div>
  );
}
