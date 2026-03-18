import { useEffect, useState, useMemo } from 'react';
import { fetchCrossRepoCatalog } from '../api/client.ts';
import type { SystemCatalogEntry } from '../api/client.ts';

type SortKey = 'name' | 'repo' | 'consumers' | 'producers';
type SortDir = 'asc' | 'desc';

interface Props {
  repo?: string;
}

export default function ServiceCatalogTable({ repo }: Props) {
  const [entries, setEntries] = useState<SystemCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  useEffect(() => {
    setLoading(true);
    setSearch('');
    fetchCrossRepoCatalog(repo)
      .then((data) => setEntries(data.entries))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [repo]);

  const filtered = useMemo(() => {
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter((e) => e.entry.name.toLowerCase().includes(q));
  }, [entries, search]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = a.entry.name.localeCompare(b.entry.name);
      else if (sortKey === 'repo') cmp = a.repo.localeCompare(b.repo);
      else if (sortKey === 'consumers') cmp = a.consumers.length - b.consumers.length;
      else if (sortKey === 'producers') cmp = a.producers.length - b.producers.length;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  function SortIndicator({ k }: { k: SortKey }) {
    if (sortKey !== k) return <span className="ml-1 text-slate-300">↕</span>;
    return <span className="ml-1">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  }

  const withCrossRepoConsumers = entries.filter((e) => e.consumers.length > 0).length;

  if (loading) return <div className="p-8 text-center text-slate-500">Loading service catalog...</div>;

  if (entries.length === 0) {
    return <p className="text-slate-500 text-center py-12">No service catalog entries found.</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-800">Service Catalog</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {entries.length} services ({withCrossRepoConsumers} with cross-repo consumers)
          </p>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search services..."
          className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white w-64"
        />
      </div>
      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100"
                onClick={() => toggleSort('name')}
              >
                Service<SortIndicator k="name" />
              </th>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100"
                onClick={() => toggleSort('repo')}
              >
                Owner Repo<SortIndicator k="repo" />
              </th>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100"
                onClick={() => toggleSort('consumers')}
              >
                Consumers<SortIndicator k="consumers" />
              </th>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100"
                onClick={() => toggleSort('producers')}
              >
                Producers<SortIndicator k="producers" />
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((e, i) => (
              <tr key={`${e.repo}-${e.entry.name}`} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                <td className="px-3 py-1.5">
                  <div className="font-medium text-slate-800">{e.entry.name}</div>
                  {e.entry.purpose && (
                    <div className="text-xs text-slate-400 truncate max-w-xs" title={e.entry.purpose}>{e.entry.purpose}</div>
                  )}
                </td>
                <td className="px-3 py-1.5">
                  <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">{e.repo}</span>
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {e.consumers.length > 0 ? e.consumers.map((c) => (
                      <span key={c} className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800">{c}</span>
                    )) : <span className="text-xs text-slate-400">-</span>}
                  </div>
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {e.producers.length > 0 ? e.producers.map((p) => (
                      <span key={p} className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800">{p}</span>
                    )) : <span className="text-xs text-slate-400">-</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs text-slate-400">
        Services discovered across repos with cross-repo consumer/producer relationships.
      </p>
    </div>
  );
}
