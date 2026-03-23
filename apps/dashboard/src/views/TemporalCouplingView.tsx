import { useEffect, useState, useMemo } from 'react';
import { fetchTemporalCoupling, fetchRepos } from '../api/client.ts';
import type { CoupledPairRow } from '../api/client.ts';
import { EmptyState } from '../components/shared/EmptyState.tsx';

type SortKey = 'coChangeCount' | 'confidence' | 'fileA' | 'fileB';

const BOILERPLATE_BASENAMES = new Set([
  'changelog.md', 'changelog', 'package.json', 'package-lock.json',
  'yarn.lock', 'pnpm-lock.yaml', '.gitignore', 'license', 'readme.md',
  'tsconfig.json', 'tsconfig.build.json', 'turbo.json', 'nx.json',
  'lerna.json', 'renovate.json',
]);

const BOILERPLATE_PREFIXES = ['.github/', '.husky/'];

const BOILERPLATE_PATTERNS = [
  /\.eslintrc\b/, /\.prettierrc\b/, /jest\.config\b/, /vitest\.config\b/,
];

function isBoilerplate(filePath: string): boolean {
  const basename = filePath.split('/').pop()?.toLowerCase() ?? '';
  if (BOILERPLATE_BASENAMES.has(basename)) return true;
  const lower = filePath.toLowerCase();
  for (const prefix of BOILERPLATE_PREFIXES) {
    if (lower.includes(`/${prefix}`) || lower.startsWith(prefix)) return true;
  }
  for (const pat of BOILERPLATE_PATTERNS) {
    if (pat.test(basename)) return true;
  }
  return false;
}

export default function TemporalCouplingView() {
  const [pairs, setPairs] = useState<CoupledPairRow[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('coChangeCount');
  const [sortAsc, setSortAsc] = useState(false);
  const [hideBoilerplate, setHideBoilerplate] = useState(true);

  useEffect(() => {
    Promise.all([fetchTemporalCoupling(), fetchRepos()])
      .then(([data, repoData]) => {
        setPairs(data);
        setRepos(repoData.repos);
      })
      .catch(() => {
        setPairs([]);
        setRepos([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const { filtered, totalBeforeFilter, hiddenCount } = useMemo(() => {
    const repoFiltered = selectedRepo ? pairs.filter((p) => p.repo === selectedRepo) : pairs;
    const total = repoFiltered.length;
    const base = hideBoilerplate
      ? repoFiltered.filter((p) => !isBoilerplate(p.fileA) && !isBoilerplate(p.fileB))
      : repoFiltered;
    const hidden = total - base.length;
    const sorted = [...base].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string' && typeof bv === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return { filtered: sorted, totalBeforeFilter: total, hiddenCount: hidden };
  }, [pairs, selectedRepo, sortKey, sortAsc, hideBoilerplate]);

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  }

  function arrow(key: SortKey) {
    if (key !== sortKey) return '';
    return sortAsc ? ' \u25B2' : ' \u25BC';
  }

  function confidenceBadge(c: number) {
    if (c >= 0.8) return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
    return 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300';
  }

  if (loading) return (
    <div className="p-8 text-center animate-pulse">
      <div className="h-6 bg-slate-200 dark:bg-slate-700 rounded w-48 mx-auto mb-4" />
      <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-700">
        <div className="h-8 bg-slate-100 dark:bg-slate-800 border-b dark:border-slate-700" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-7 bg-white dark:bg-slate-800 border-b dark:border-slate-700 last:border-0" />
        ))}
      </div>
    </div>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Temporal Coupling</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Showing {filtered.length} of {totalBeforeFilter} pairs{hiddenCount > 0 && ` (${hiddenCount} hidden)`}
          </span>
          <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hideBoilerplate}
              onChange={(e) => setHideBoilerplate(e.target.checked)}
              className="rounded border-slate-300 dark:border-slate-600"
            />
            Hide boilerplate
          </label>
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200"
          >
            <option value="">All repos ({pairs.length} pairs)</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r} ({pairs.filter((p) => p.repo === r).length})
              </option>
            ))}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon="search"
          title={`No temporal coupling detected${selectedRepo ? ` for ${selectedRepo}` : ''}`}
          description="Files that are frequently committed together will appear here."
        />
      ) : (
        <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="text-left px-3 py-2 cursor-pointer select-none text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => handleSort('fileA')}>
                  File A{arrow('fileA')}
                </th>
                <th className="text-left px-3 py-2 cursor-pointer select-none text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => handleSort('fileB')}>
                  File B{arrow('fileB')}
                </th>
                <th className="text-right px-3 py-2 cursor-pointer select-none text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => handleSort('coChangeCount')}>
                  Co-changes{arrow('coChangeCount')}
                </th>
                <th className="text-right px-3 py-2 cursor-pointer select-none text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => handleSort('confidence')}>
                  Confidence{arrow('confidence')}
                </th>
                <th className="text-right px-3 py-2 text-slate-700 dark:text-slate-300">Support A</th>
                <th className="text-right px-3 py-2 text-slate-700 dark:text-slate-300">Support B</th>
                {!selectedRepo && <th className="text-left px-3 py-2 text-slate-700 dark:text-slate-300">Repo</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => (
                <tr key={`${p.repo}-${p.fileA}-${p.fileB}`} className={i % 2 === 0 ? 'bg-white dark:bg-slate-800' : 'bg-slate-50 dark:bg-slate-900/50'}>
                  <td className="px-3 py-1.5 font-mono text-xs truncate max-w-xs text-slate-700 dark:text-slate-300" title={p.fileA}>{p.fileA}</td>
                  <td className="px-3 py-1.5 font-mono text-xs truncate max-w-xs text-slate-700 dark:text-slate-300" title={p.fileB}>{p.fileB}</td>
                  <td className="px-3 py-1.5 text-right font-semibold text-slate-800 dark:text-slate-200">{p.coChangeCount}</td>
                  <td className="px-3 py-1.5 text-right">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${confidenceBadge(p.confidence)}`}>
                      {(p.confidence * 100).toFixed(0)}%
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right text-slate-600 dark:text-slate-400">{(p.supportA * 100).toFixed(0)}%</td>
                  <td className="px-3 py-1.5 text-right text-slate-600 dark:text-slate-400">{(p.supportB * 100).toFixed(0)}%</td>
                  {!selectedRepo && <td className="px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">{p.repo}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
        Pairs sorted by {sortKey}. Confidence &ge; 80% highlighted as warnings.
      </p>
    </div>
  );
}
