import { useEffect, useState } from 'react';
import { fetchCrossRepoFaults } from '../api/client.ts';
import type { CrossRepoFaultLink } from '../api/client.ts';

export default function CascadingFaultsTable() {
  const [faultLinks, setFaultLinks] = useState<CrossRepoFaultLink[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchCrossRepoFaults()
      .then((data) => setFaultLinks(data.faultLinks))
      .catch(() => setFaultLinks([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-center text-slate-500">Loading cascading faults...</div>;

  if (faultLinks.length === 0) {
    return <p className="text-slate-500 text-center py-12">No cascading fault links detected across repos.</p>;
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-slate-800 mb-4">
        Cascading Fault Links <span className="text-sm font-normal text-slate-500">({faultLinks.length})</span>
      </h2>
      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="text-left px-3 py-2">Source Repo</th>
              <th className="text-left px-3 py-2">Target Repo</th>
              <th className="text-left px-3 py-2">Endpoint</th>
              <th className="text-right px-3 py-2">Source Faults</th>
              <th className="text-right px-3 py-2">Target Faults</th>
            </tr>
          </thead>
          <tbody>
            {faultLinks.map((fl, i) => (
              <tr key={`${fl.sourceRepo}-${fl.targetRepo}-${fl.endpoint}`} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                <td className="px-3 py-1.5">
                  <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">{fl.sourceRepo}</span>
                </td>
                <td className="px-3 py-1.5">
                  <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">{fl.targetRepo}</span>
                </td>
                <td className="px-3 py-1.5 font-mono text-xs">{fl.endpoint}</td>
                <td className="px-3 py-1.5 text-right font-semibold">{fl.sourceFaultTreeCount}</td>
                <td className="px-3 py-1.5 text-right font-semibold">{fl.targetFaultTreeCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs text-slate-400">
        Fault propagation paths between repos connected by service endpoints.
      </p>
    </div>
  );
}
