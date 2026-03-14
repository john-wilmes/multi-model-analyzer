import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchMetrics, fetchFindings } from '../api/client.ts';
import ZoneChart, { type ModuleMetrics } from './ZoneChart.tsx';

interface Finding {
  ruleId?: string;
  level?: string;
  message?: string;
  location?: string;
}

function toModuleMetrics(raw: unknown): ModuleMetrics | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.module !== 'string' ||
    typeof r.instability !== 'number' ||
    typeof r.abstractness !== 'number'
  )
    return null;
  return {
    name: r.module as string,
    instability: r.instability,
    abstractness: r.abstractness,
  };
}

export default function RepoDetail() {
  const { name } = useParams<{ name: string }>();
  const repo = name ?? '';

  const [metrics, setMetrics] = useState<ModuleMetrics[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!repo) return;
    Promise.all([
      fetchMetrics(repo),
      fetchFindings({ repo, limit: '10' }),
    ])
      .then(([metricsData, findingsData]) => {
        const ms = (metricsData as unknown[])
          .map(toModuleMetrics)
          .filter((m): m is ModuleMetrics => m !== null);
        setMetrics(ms);
        setFindings((findingsData.results ?? []) as Finding[]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [repo]);

  if (loading) return <p className="text-slate-500">Loading...</p>;

  const total = metrics.length;
  const avgInstability =
    total > 0 ? metrics.reduce((s, m) => s + m.instability, 0) / total : 0;
  const avgAbstractness =
    total > 0 ? metrics.reduce((s, m) => s + m.abstractness, 0) / total : 0;
  const painZoneCount = metrics.filter((m) => {
    const d = Math.abs(m.instability + m.abstractness - 1) / Math.sqrt(2);
    return d >= 0.3 && !(m.abstractness > 0.5 && m.instability < 0.5);
  }).length;
  const painZonePct = total > 0 ? (painZoneCount / total) * 100 : 0;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-slate-800">{repo}</h2>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Total modules', value: total },
          { label: 'Avg instability', value: avgInstability.toFixed(2) },
          { label: 'Avg abstractness', value: avgAbstractness.toFixed(2) },
          { label: 'Pain zone', value: `${painZonePct.toFixed(0)}%` },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="bg-white rounded-lg shadow-sm border p-4"
          >
            <p className="text-xs text-slate-500 mb-1">{label}</p>
            <p className="text-xl font-semibold text-slate-800">{value}</p>
          </div>
        ))}
      </div>

      {/* Zone chart */}
      {metrics.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h3 className="text-base font-semibold text-slate-700 mb-2">
            Zone Chart
          </h3>
          <ZoneChart repo={repo} metrics={metrics} />
        </div>
      )}

      {/* Top findings */}
      <div className="bg-white rounded-lg shadow-sm border p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-slate-700">
            Top Findings
          </h3>
          <Link
            to={`/findings?repo=${encodeURIComponent(repo)}`}
            className="text-sm text-blue-600 hover:underline"
          >
            View all
          </Link>
        </div>
        {findings.length === 0 ? (
          <p className="text-slate-500 text-sm">No findings.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b">
                <th className="pb-2 pr-3">Severity</th>
                <th className="pb-2 pr-3">Rule</th>
                <th className="pb-2">Message</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-2 pr-3">
                    <SeverityBadge level={f.level} />
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs text-slate-600">
                    {f.ruleId ?? '-'}
                  </td>
                  <td className="py-2 text-slate-700 truncate max-w-xs">
                    {typeof f.message === 'object' && f.message !== null ? (f.message as { text?: string }).text ?? '-' : f.message ?? '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SeverityBadge({ level }: { level?: string }) {
  const classes: Record<string, string> = {
    error: 'bg-red-100 text-red-700',
    warning: 'bg-yellow-100 text-yellow-700',
    note: 'bg-blue-100 text-blue-700',
  };
  const cls = classes[level ?? ''] ?? 'bg-slate-100 text-slate-600';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {level ?? 'note'}
    </span>
  );
}
