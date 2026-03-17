import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchMetrics, fetchFindings, fetchDsm, fetchAtdiByRepo, fetchDebtByRepo, fetchTemporalCouplingByRepo, type DsmData, type AtdiRepoScore, type RepoDebtSummary, type RepoTemporalCoupling } from '../api/client.ts';
import ZoneChart, { type ModuleMetrics } from './ZoneChart.tsx';
import DsmChart from './DsmChart.tsx';
import AtdiGauge from './AtdiGauge.tsx';
import DebtBreakdownChart, { type DebtCategory } from './DebtBreakdownChart.tsx';

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
  const [dsm, setDsm] = useState<DsmData | null>(null);
  const [atdi, setAtdi] = useState<AtdiRepoScore | null>(null);
  const [debt, setDebt] = useState<RepoDebtSummary | null>(null);
  const [coupling, setCoupling] = useState<RepoTemporalCoupling | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!repo) return;
    Promise.all([
      fetchMetrics(repo),
      fetchFindings({ repo, limit: '10' }),
      fetchDsm(repo).catch(() => null),
      fetchAtdiByRepo(repo).catch(() => null),
      fetchDebtByRepo(repo).catch(() => null),
      fetchTemporalCouplingByRepo(repo).catch(() => null),
    ])
      .then(([metricsData, findingsData, dsmData, atdiData, debtData, couplingData]) => {
        const ms = (metricsData as unknown[])
          .map(toModuleMetrics)
          .filter((m): m is ModuleMetrics => m !== null);
        setMetrics(ms);
        setFindings((findingsData.results ?? []) as Finding[]);
        setDsm(dsmData as DsmData | null);
        setAtdi(atdiData);
        setDebt(debtData);
        setCoupling(couplingData);
      })
      .catch((err: unknown) => console.error("Failed to fetch repo data:", err))
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

      {/* ATDI Score */}
      {atdi && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h3 className="text-base font-semibold text-slate-700 mb-3">ATDI Score</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
            <div className="flex justify-center">
              <AtdiGauge score={atdi.score} size={160} />
            </div>
            <div className="space-y-3">
              {[
                { label: 'Findings density', value: (atdi.components.findingsDensity * 100).toFixed(0) + '%' },
                { label: 'Zone ratio', value: (atdi.components.zoneRatio * 100).toFixed(0) + '%' },
                { label: 'Avg distance', value: atdi.components.avgDistance.toFixed(2) },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between text-sm">
                  <span className="text-slate-600">{label}</span>
                  <span className="font-medium text-slate-800">{value}</span>
                </div>
              ))}
              <div className="flex gap-3 text-xs pt-1">
                <span className="text-red-600">{atdi.findingCounts.error} errors</span>
                <span className="text-yellow-600">{atdi.findingCounts.warning} warnings</span>
                <span className="text-blue-600">{atdi.findingCounts.note} notes</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Technical Debt */}
      {debt && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h3 className="text-base font-semibold text-slate-700 mb-3">Technical Debt</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
            <div className="flex flex-col items-center justify-center py-4">
              <p className="text-3xl font-bold text-slate-800">{debt.totalHours}h</p>
              <p className="text-xs text-slate-500 mt-1">Total remediation effort</p>
            </div>
            <DebtBreakdownChart
              categories={Object.entries(debt.byRule).map(([ruleId, { count, minutes }]): DebtCategory => ({
                category: ruleId.includes('/') ? ruleId.split('/').pop() ?? ruleId : ruleId,
                debtMinutes: minutes,
                debtHours: Math.round(minutes / 60),
                findingCount: count,
              }))}
            />
          </div>
        </div>
      )}

      {/* Zone chart */}
      {metrics.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h3 className="text-base font-semibold text-slate-700 mb-2">
            Zone Chart
          </h3>
          <ZoneChart repo={repo} metrics={metrics} />
        </div>
      )}

      {/* Dependency Structure Matrix */}
      {dsm && dsm.modules.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h3 className="text-base font-semibold text-slate-700 mb-2">
            Dependency Structure Matrix
          </h3>
          <p className="text-xs text-slate-500 mb-3">
            Rows import columns. Darker cells indicate more dependencies. {dsm.modules.length} modules shown.
          </p>
          <DsmChart data={dsm} />
        </div>
      )}

      {/* Dependency graph link */}
      <Link
        to={`/graph/${encodeURIComponent(repo)}`}
        className="text-sm text-blue-600 hover:underline"
      >
        View dependency graph &rarr;
      </Link>

      {/* Temporal Coupling */}
      {coupling && coupling.pairs.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h3 className="text-base font-semibold text-slate-700 mb-1">
            Temporal Coupling
          </h3>
          <p className="text-xs text-slate-500 mb-3">
            {coupling.commitsAnalyzed} commits analyzed &middot; Top 10 co-changing file pairs
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b">
                <th className="pb-2 pr-3">File A</th>
                <th className="pb-2 pr-3">File B</th>
                <th className="pb-2 pr-3 text-right">Co-changes</th>
                <th className="pb-2 text-right">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {coupling.pairs
                .slice()
                .sort((a, b) => b.coChangeCount - a.coChangeCount)
                .slice(0, 10)
                .map((p, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs text-slate-600 truncate max-w-[200px]" title={p.fileA}>
                      {shortenPath(p.fileA)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-slate-600 truncate max-w-[200px]" title={p.fileB}>
                      {shortenPath(p.fileB)}
                    </td>
                    <td className="py-2 pr-3 text-right text-slate-700">{p.coChangeCount}</td>
                    <td className="py-2 text-right text-slate-700">{(p.confidence * 100).toFixed(0)}%</td>
                  </tr>
                ))}
            </tbody>
          </table>
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

function shortenPath(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 2) return filePath;
  return parts.slice(-2).join('/');
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
