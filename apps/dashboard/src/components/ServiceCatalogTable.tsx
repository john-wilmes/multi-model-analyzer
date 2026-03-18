import { useEffect, useState, useMemo } from 'react';
import { fetchCrossRepoCatalog } from '../api/client.ts';
import type { SystemCatalogEntry } from '../api/client.ts';

export default function ServiceCatalogTable() {
  const [entries, setEntries] = useState<SystemCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetchCrossRepoCatalog()
      .then((data) => setEntries(data.entries))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter((e) => e.entry.name.toLowerCase().includes(q));
  }, [entries, search]);

  if (loading) return <div className="p-8 text-center text-slate-500">Loading service catalog...</div>;

  if (entries.length === 0) {
    return <p className="text-slate-500 text-center py-12">No service catalog entries found.</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-slate-800">
          Service Catalog <span className="text-sm font-normal text-slate-500">({filtered.length})</span>
        </h2>
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
              <th className="text-left px-3 py-2">Service</th>
              <th className="text-left px-3 py-2">Owner Repo</th>
              <th className="text-left px-3 py-2">Consumers</th>
              <th className="text-left px-3 py-2">Producers</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e, i) => (
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
