import { useEffect, useState, useMemo } from 'react';
import { fetchPatterns, fetchRepos } from '../api/client.ts';
import { EmptyState } from '../components/shared/EmptyState.tsx';

// DetectedPattern shape as stored by the indexer (DetectedPattern[] per repo)
interface LogicalLocation {
  uri?: string;
  logicalLocations?: Array<{ name?: string; fullyQualifiedName?: string }>;
}

interface DetectedPattern {
  name: string;
  kind: string;
  locations: LogicalLocation[];
  confidence: number;
}

interface PatternRow extends DetectedPattern {
  repo: string;
}

const ALL_KINDS = [
  'adapter', 'facade', 'observer', 'factory', 'singleton',
  'repository', 'middleware', 'decorator', 'builder', 'proxy', 'strategy',
] as const;

type PatternKind = typeof ALL_KINDS[number];

const KIND_LABELS: Record<string, string> = {
  adapter: 'Adapter',
  facade: 'Facade',
  observer: 'Observer',
  factory: 'Factory',
  singleton: 'Singleton',
  repository: 'Repository',
  middleware: 'Middleware',
  decorator: 'Decorator',
  builder: 'Builder',
  proxy: 'Proxy',
  strategy: 'Strategy',
};

function confidenceBadge(c: number): string {
  if (c >= 0.8) return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
  if (c >= 0.5) return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400';
  return 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300';
}

function patternLocation(p: DetectedPattern): string {
  const loc = p.locations[0];
  if (!loc) return '';
  if (loc.uri) return loc.uri;
  const ll = loc.logicalLocations?.[0];
  return ll?.fullyQualifiedName ?? ll?.name ?? '';
}

export default function PatternsView() {
  const [allPatterns, setAllPatterns] = useState<PatternRow[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [expandedKind, setExpandedKind] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchRepos()
      .then(async ({ repos: repoList }) => {
        setRepos(repoList);
        const results = await Promise.allSettled(
          repoList.map((repo) =>
            fetchPatterns(repo).then((data) => {
              const patterns = Array.isArray(data) ? (data as DetectedPattern[]) : [];
              return patterns.map((p): PatternRow => ({ ...p, repo }));
            })
          )
        );
        const rows: PatternRow[] = [];
        for (const r of results) {
          if (r.status === 'fulfilled') rows.push(...r.value);
        }
        setAllPatterns(rows);
      })
      .catch(() => {
        setRepos([]);
        setAllPatterns([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    return selectedRepo ? allPatterns.filter((p) => p.repo === selectedRepo) : allPatterns;
  }, [allPatterns, selectedRepo]);

  // Count per kind
  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of filtered) {
      counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
    }
    return counts;
  }, [filtered]);

  // Group by kind for the detail accordion
  const byKind = useMemo(() => {
    const groups = new Map<string, PatternRow[]>();
    for (const p of filtered) {
      const arr = groups.get(p.kind) ?? [];
      arr.push(p);
      groups.set(p.kind, arr);
    }
    return groups;
  }, [filtered]);

  const activeKinds = useMemo(() => {
    return ALL_KINDS.filter((k) => (kindCounts.get(k) ?? 0) > 0);
  }, [kindCounts]);

  function toggleKind(kind: string) {
    setExpandedKind((prev) => (prev === kind ? null : kind));
  }

  if (loading) return (
    <div className="p-8 animate-pulse space-y-4">
      <div className="h-6 bg-slate-200 dark:bg-slate-700 rounded w-48 mb-6" />
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-20 bg-slate-100 dark:bg-slate-800 rounded-lg border dark:border-slate-700" />
        ))}
      </div>
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Design Patterns</h1>
          <span className="text-xs font-semibold bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded-full">
            {filtered.length} instances
          </span>
        </div>
        <select
          value={selectedRepo}
          onChange={(e) => setSelectedRepo(e.target.value)}
          className="border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200"
        >
          <option value="">All repos ({allPatterns.length} instances)</option>
          {repos.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon="search"
          title={`No design patterns detected${selectedRepo ? ` in ${selectedRepo}` : ''}`}
          description="Patterns such as adapter, facade, factory, and singleton will appear here after indexing."
        />
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-8">
            {ALL_KINDS.map((kind) => {
              const count = kindCounts.get(kind) ?? 0;
              const isActive = count > 0;
              return (
                <button
                  key={kind}
                  onClick={() => isActive && toggleKind(kind)}
                  disabled={!isActive}
                  className={`bg-white dark:bg-slate-800 rounded-lg shadow-sm border p-4 text-left transition-colors ${
                    isActive
                      ? 'dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-500 cursor-pointer'
                      : 'dark:border-slate-700 opacity-40 cursor-default'
                  } ${expandedKind === kind ? 'border-blue-400 dark:border-blue-500 ring-1 ring-blue-400 dark:ring-blue-500' : 'border-slate-200'}`}
                >
                  <div className="text-2xl font-bold text-slate-800 dark:text-slate-100">{count}</div>
                  <div className="text-sm text-slate-600 dark:text-slate-300 mt-0.5">{KIND_LABELS[kind] ?? kind}</div>
                  {isActive && (
                    <div className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                      {expandedKind === kind ? 'hide details' : 'show details'}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Detail accordion */}
          <div className="space-y-4">
            {(expandedKind ? [expandedKind as PatternKind] : activeKinds).map((kind) => {
              const rows = byKind.get(kind) ?? [];
              if (rows.length === 0) return null;
              return (
                <div key={kind} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
                  <div
                    className="flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 cursor-pointer"
                    onClick={() => toggleKind(kind)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleKind(kind))}
                  >
                    <span className="font-semibold text-slate-800 dark:text-slate-100">
                      {KIND_LABELS[kind] ?? kind}
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="text-xs bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded-full font-semibold">
                        {rows.length}
                      </span>
                      <span className="text-slate-400 dark:text-slate-500 text-xs">
                        {expandedKind === kind ? '\u25B2' : '\u25BC'}
                      </span>
                    </div>
                  </div>
                  {expandedKind === kind && (
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
                        <tr>
                          <th className="text-left px-3 py-2 text-slate-700 dark:text-slate-300">Name</th>
                          <th className="text-left px-3 py-2 text-slate-700 dark:text-slate-300">File / Location</th>
                          {!selectedRepo && (
                            <th className="text-left px-3 py-2 text-slate-700 dark:text-slate-300">Repo</th>
                          )}
                          <th className="text-right px-3 py-2 text-slate-700 dark:text-slate-300">Confidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((p, i) => {
                          const loc = patternLocation(p);
                          return (
                            <tr
                              key={`${p.repo}-${p.name}-${i}`}
                              className={i % 2 === 0 ? 'bg-white dark:bg-slate-800' : 'bg-slate-50 dark:bg-slate-900/50'}
                            >
                              <td className="px-3 py-1.5 font-mono text-xs text-slate-700 dark:text-slate-300">{p.name}</td>
                              <td className="px-3 py-1.5 font-mono text-xs text-slate-500 dark:text-slate-400 truncate max-w-xs" title={loc}>
                                {loc || '—'}
                              </td>
                              {!selectedRepo && (
                                <td className="px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">{p.repo}</td>
                              )}
                              <td className="px-3 py-1.5 text-right">
                                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${confidenceBadge(p.confidence)}`}>
                                  {(p.confidence * 100).toFixed(0)}%
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <p className="mt-6 text-xs text-slate-400 dark:text-slate-500">
        Patterns detected via structural signature analysis. Confidence &ge; 80% (amber) indicates high-confidence matches.
      </p>
    </div>
  );
}
