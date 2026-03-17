import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchRepos, fetchMetricsSummary, fetchPractices, fetchHotspots, fetchAllMetrics, type ModuleMetric } from '../api/client.ts';
import CrossRepoChart, { type RepoPoint } from './CrossRepoChart.tsx';
import MainSequenceChart from './MainSequenceChart.tsx';

interface RepoSummary {
  name: string;
  grade?: string;
  errorCount?: number;
  warningCount?: number;
  noteCount?: number;
  avgInstability?: number;
  avgAbstractness?: number;
}

interface AtdiCategoryBreakdown {
  category: string;
  contribution: number;
  findingDensity: number;
}

interface AtdiScore {
  score: number;
  trend: "worsening" | "stable" | "improving";
  newFindingCount: number;
  totalFindingCount: number;
  categoryBreakdown: AtdiCategoryBreakdown[];
}

interface DebtCategoryEstimate {
  category: string;
  debtMinutes: number;
  debtHours: number;
  findingCount: number;
}

interface DebtEstimate {
  totalDebtMinutes: number;
  totalDebtHours: number;
  byCategory: DebtCategoryEstimate[];
  byRule: Array<{
    ruleId: string;
    category: string;
    findingCount: number;
    minutesPerInstance: number;
    totalMinutes: number;
  }>;
}

interface PracticesData {
  executive?: {
    grade?: string;
    score?: number;
    headline?: string;
    topActions?: string[];
  };
  structural?: {
    repos?: Array<{
      repo: string;
      painZonePct?: number;
      painRating?: string;
      avgDistance?: number;
    }>;
  };
  scorecard?: Array<{
    category: string;
    errorCount: number;
    warningCount: number;
    noteCount: number;
  }>;
  atdi?: AtdiScore;
  debt?: DebtEstimate;
}

interface MetricsSummaryEntry {
  repo: string;
  moduleCount?: number;
  avgInstability?: number;
  avgAbstractness?: number;
  avgDistance?: number;
  painZoneCount?: number;
  uselessnessZoneCount?: number;
}


interface HotspotEntry {
  repo: string;
  filePath: string;
  churn: number;
  symbolCount: number;
  hotspotScore: number;
}

const GRADE_COLORS: Record<string, string> = {
  A: 'text-green-600',
  B: 'text-lime-600',
  C: 'text-yellow-600',
  D: 'text-orange-500',
  F: 'text-red-600',
};

export default function Overview() {
  const [repoSummaries, setRepoSummaries] = useState<RepoSummary[]>([]);
  const [repoPoints, setRepoPoints] = useState<RepoPoint[]>([]);
  const [practices, setPractices] = useState<PracticesData | null>(null);
  const [hotspots, setHotspots] = useState<HotspotEntry[]>([]);
  const [moduleMetrics, setModuleMetrics] = useState<ModuleMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([fetchRepos(), fetchMetricsSummary(), fetchPractices(), fetchHotspots(), fetchAllMetrics()])
      .then(([reposData, metricsSummary, practicesData, hotspotsData, allMetricsData]) => {
        setModuleMetrics(allMetricsData as ModuleMetric[]);
        setHotspots((hotspotsData as HotspotEntry[]).slice(0, 10));
        const pd = practicesData as PracticesData;
        setPractices(pd);
        const ms = metricsSummary as Record<string, MetricsSummaryEntry>;

        // Build a lookup from scorecard for finding counts
        const scorecard = pd.scorecard ?? [];
        const totalErrors = scorecard.reduce((s, c) => s + c.errorCount, 0);
        const totalWarnings = scorecard.reduce((s, c) => s + c.warningCount, 0);
        const totalNotes = scorecard.reduce((s, c) => s + c.noteCount, 0);

        const summaries: RepoSummary[] = reposData.repos.map((repo) => {
          const mse = ms[repo];
          return {
            name: repo,
            avgInstability: mse?.avgInstability,
            avgAbstractness: mse?.avgAbstractness,
            // Per-repo finding counts aren't available; show module count instead
            errorCount: mse?.painZoneCount,
            warningCount: mse?.uselessnessZoneCount,
            noteCount: mse?.moduleCount,
          };
        });
        setRepoSummaries(summaries);

        const points: RepoPoint[] = reposData.repos
          .map((repo) => {
            const mse = ms[repo];
            return {
              name: repo,
              instability: mse?.avgInstability ?? 0,
              abstractness: mse?.avgAbstractness ?? 0,
              moduleCount: mse?.moduleCount ?? 0,
              painZoneCount: mse?.painZoneCount ?? 0,
              uselessnessZoneCount: mse?.uselessnessZoneCount ?? 0,
            };
          })
          .filter((p) => p.moduleCount > 0);
        setRepoPoints(points);

        // Store aggregate counts for potential use
        void totalErrors; void totalWarnings; void totalNotes;
      })
      .catch((err: unknown) => console.error("Failed to fetch overview data:", err))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <p className="text-slate-500">Loading...</p>;
  }

  return (
    <div className="space-y-6">
      {/* Executive summary */}
      {practices && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <div className="flex items-center gap-4">
            {practices.executive?.grade && (
              <span
                className={`text-5xl font-bold ${GRADE_COLORS[practices.executive.grade] ?? 'text-slate-700'}`}
              >
                {practices.executive.grade}
              </span>
            )}
            <div>
              <p className="text-lg font-semibold text-slate-800">
                {practices.executive?.headline ?? 'Code Health Summary'}
              </p>
              {practices.executive?.score !== undefined && (
                <p className="text-sm text-slate-500">
                  Score: {practices.executive.score}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ATDI panel */}
      {practices?.atdi && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h2 className="text-lg font-semibold text-slate-800 mb-3">Technical Debt Index</h2>
          <div className="flex items-center gap-4 mb-3">
            <span
              className={`text-4xl font-bold ${
                practices.atdi.score <= 20
                  ? 'text-green-400'
                  : practices.atdi.score <= 60
                  ? 'text-yellow-400'
                  : 'text-red-400'
              }`}
            >
              {practices.atdi.score}
              <span className="text-lg font-normal text-slate-500">/100</span>
            </span>
            <span
              className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                practices.atdi.trend === 'improving'
                  ? 'bg-green-100 text-green-700'
                  : practices.atdi.trend === 'worsening'
                  ? 'bg-red-100 text-red-700'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {practices.atdi.trend}
            </span>
            <span className="text-sm text-slate-500">
              {practices.atdi.newFindingCount} new / {practices.atdi.totalFindingCount} total findings
            </span>
          </div>
          {practices.atdi.categoryBreakdown.length > 0 && (
            <div className="space-y-1">
              {practices.atdi.categoryBreakdown
                .slice()
                .sort((a, b) => b.contribution - a.contribution)
                .map((row) => {
                  const maxContrib = Math.max(
                    ...practices.atdi!.categoryBreakdown.map((r) => r.contribution),
                    1,
                  );
                  const pct = Math.round((row.contribution / maxContrib) * 100);
                  return (
                    <div key={row.category} className="flex items-center gap-2 text-xs">
                      <span className="w-28 text-slate-600 truncate">{row.category}</span>
                      <div className="flex-1 bg-slate-100 rounded h-2">
                        <div
                          className="bg-blue-400 h-2 rounded"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-12 text-right text-slate-500">
                        {row.contribution.toFixed(1)}
                      </span>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* Debt Estimate panel */}
      {practices?.debt && practices.debt.totalDebtMinutes > 0 && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h2 className="text-lg font-semibold text-slate-800 mb-3">Estimated Remediation Cost</h2>
          <div className="flex items-center gap-4 mb-3">
            <span
              className={`text-4xl font-bold ${
                practices.debt.totalDebtHours <= 40
                  ? 'text-green-500'
                  : practices.debt.totalDebtHours <= 200
                  ? 'text-yellow-500'
                  : 'text-red-500'
              }`}
            >
              {practices.debt.totalDebtHours}
              <span className="text-lg font-normal text-slate-500">h</span>
            </span>
            <span className="text-sm text-slate-500">
              {(Math.round((practices.debt.totalDebtHours / 6) * 10) / 10).toFixed(1)} days at 6h/day
            </span>
          </div>
          {practices.debt.byCategory.length > 0 && (
            <div className="space-y-1">
              {practices.debt.byCategory
                .slice()
                .sort((a, b) => b.debtMinutes - a.debtMinutes)
                .map((cat) => {
                  const maxDebt = Math.max(
                    ...practices.debt!.byCategory.map((c) => c.debtMinutes),
                    1,
                  );
                  const pct = Math.round((cat.debtMinutes / maxDebt) * 100);
                  return (
                    <div key={cat.category} className="flex items-center gap-2 text-xs">
                      <span className="w-28 text-slate-600 truncate">{cat.category}</span>
                      <div className="flex-1 bg-slate-100 rounded h-2">
                        <div
                          className={`h-2 rounded ${
                            practices.debt!.totalDebtHours <= 40
                              ? 'bg-green-400'
                              : practices.debt!.totalDebtHours <= 200
                              ? 'bg-yellow-400'
                              : 'bg-red-400'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-12 text-right text-slate-500">
                        {cat.debtHours}h
                      </span>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* Hotspot Analysis panel */}
      {hotspots.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h2 className="text-lg font-semibold text-slate-800 mb-3">Hotspot Analysis</h2>
          <p className="text-xs text-slate-500 mb-3">
            Files with high git churn and high complexity. Top 10 shown.
          </p>
          <div className="space-y-2">
            {hotspots.map((h) => {
              const barColor =
                h.hotspotScore > 70
                  ? 'bg-red-500'
                  : h.hotspotScore > 40
                  ? 'bg-yellow-400'
                  : 'bg-green-400';
              const shortPath = h.filePath.split('/').slice(-2).join('/');
              return (
                <div key={`${h.repo}/${h.filePath}`} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="w-48 text-xs text-slate-700 truncate" title={`[${h.repo}] ${h.filePath}`}>
                      {shortPath}
                    </span>
                    <div className="flex-1 bg-slate-100 rounded h-3">
                      <div
                        className={`${barColor} h-3 rounded transition-all`}
                        style={{ width: `${h.hotspotScore}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-xs font-medium text-slate-700">
                      {h.hotspotScore}
                    </span>
                  </div>
                  <span className="text-xs text-slate-400 pl-48">
                    {h.churn} commits · {h.symbolCount} symbols · {h.repo}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Module-level main sequence */}
      {moduleMetrics.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h2 className="text-lg font-semibold text-slate-800 mb-2">
            Main Sequence — All Modules
          </h2>
          <p className="text-xs text-slate-500 mb-3">
            Each point is a module. Color indicates zone classification. Distance from the diagonal measures architectural balance.
          </p>
          <MainSequenceChart modules={moduleMetrics} />
        </div>
      )}

      {/* Cross-repo main sequence chart */}
      {repoPoints.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h2 className="text-lg font-semibold text-slate-800 mb-2">
            Architecture Health
          </h2>
          <p className="text-xs text-slate-500 mb-3">
            Each point is a repository. Size reflects module count. Click to drill down.
          </p>
          <CrossRepoChart repos={repoPoints} />
        </div>
      )}

      {/* Repo cards */}
      <div>
        <h2 className="text-lg font-semibold text-slate-800 mb-3">
          Repositories
        </h2>
        {repoSummaries.length === 0 ? (
          <p className="text-slate-500 text-sm">No repositories indexed.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {repoSummaries.map((repo) => (
              <button
                key={repo.name}
                onClick={() =>
                  navigate(`/repo/${encodeURIComponent(repo.name)}`)
                }
                className="bg-white rounded-lg shadow-sm border p-4 text-left hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-slate-800 truncate">
                    {repo.name}
                  </span>
                  {repo.grade && (
                    <span
                      className={`text-xl font-bold ${GRADE_COLORS[repo.grade] ?? 'text-slate-700'}`}
                    >
                      {repo.grade}
                    </span>
                  )}
                </div>

                {/* Zone badges */}
                <div className="flex gap-2 mb-3">
                  {(repo.errorCount ?? 0) > 0 && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                      {repo.errorCount} pain zone
                    </span>
                  )}
                  {(repo.warningCount ?? 0) > 0 && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
                      {repo.warningCount} useless zone
                    </span>
                  )}
                  {(repo.noteCount ?? 0) > 0 && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                      {repo.noteCount} modules
                    </span>
                  )}
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-2 gap-2 text-xs text-slate-500">
                  {repo.avgInstability !== undefined && (
                    <div>
                      <span className="block font-medium text-slate-700">
                        Instability
                      </span>
                      {repo.avgInstability.toFixed(2)}
                    </div>
                  )}
                  {repo.avgAbstractness !== undefined && (
                    <div>
                      <span className="block font-medium text-slate-700">
                        Abstractness
                      </span>
                      {repo.avgAbstractness.toFixed(2)}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
