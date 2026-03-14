import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchRepos, fetchMetricsSummary, fetchPractices } from '../api/client.ts';

interface RepoSummary {
  name: string;
  grade?: string;
  errorCount?: number;
  warningCount?: number;
  noteCount?: number;
  avgInstability?: number;
  avgAbstractness?: number;
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

const GRADE_COLORS: Record<string, string> = {
  A: 'text-green-600',
  B: 'text-lime-600',
  C: 'text-yellow-600',
  D: 'text-orange-500',
  F: 'text-red-600',
};

export default function Overview() {
  const [repoSummaries, setRepoSummaries] = useState<RepoSummary[]>([]);
  const [practices, setPractices] = useState<PracticesData | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([fetchRepos(), fetchMetricsSummary(), fetchPractices()])
      .then(([reposData, metricsSummary, practicesData]) => {
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

        // Store aggregate counts for potential use
        void totalErrors; void totalWarnings; void totalNotes;
      })
      .catch(() => {})
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
