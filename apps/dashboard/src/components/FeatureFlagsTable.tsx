import { useEffect, useState } from 'react';
import { fetchCrossRepoFeatures } from '../api/client.ts';
import type { SharedFlag } from '../api/client.ts';

export default function FeatureFlagsTable() {
  const [flags, setFlags] = useState<SharedFlag[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchCrossRepoFeatures()
      .then((data) => setFlags(data.flags))
      .catch(() => setFlags([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-center text-slate-500">Loading feature flags...</div>;

  if (flags.length === 0) {
    return <p className="text-slate-500 text-center py-12">No shared feature flags detected across repos.</p>;
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-slate-800 mb-4">
        Shared Feature Flags <span className="text-sm font-normal text-slate-500">({flags.length})</span>
      </h2>
      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="text-left px-3 py-2">Flag Name</th>
              <th className="text-left px-3 py-2">Repos</th>
              <th className="text-left px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {flags.map((f, i) => (
              <tr key={f.name} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                <td className="px-3 py-1.5 font-mono text-xs">{f.name}</td>
                <td className="px-3 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {f.repos.map((r) => (
                      <span key={r} className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                        {r}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-1.5">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    f.coordinated
                      ? 'bg-green-100 text-green-800'
                      : 'bg-amber-100 text-amber-800'
                  }`}>
                    {f.coordinated ? 'Coordinated' : 'Uncoordinated'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs text-slate-400">
        Flags appearing in 2+ repos. Uncoordinated flags have no dependency edge between sharing repos.
      </p>
    </div>
  );
}
