import { useEffect, useState, useMemo, useRef } from 'react';
import { fetchCrossRepoFeatures, fetchRepoFlags } from '../api/client.ts';
import type { SharedFlag, RepoFlag } from '../api/client.ts';

type SortKey = 'name' | 'repoCount' | 'coordinated';
type SortDir = 'asc' | 'desc';
type AllFlagsSortKey = 'name' | 'repo' | 'source';
type ViewTab = 'shared' | 'all';

const PAGE_SIZE = 25;

function isSharedFlag(value: unknown): value is SharedFlag {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<SharedFlag>;
  return (
    typeof v.name === 'string' &&
    typeof v.coordinated === 'boolean' &&
    Array.isArray(v.repos) &&
    v.repos.every((r) => typeof r === 'string')
  );
}

interface Props {
  repo?: string;
}

// ── Shared Flags view ────────────────────────────────────────────────────────

function SharedFlagsView({ repo }: { repo?: string }) {
  const [flags, setFlags] = useState<SharedFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  useEffect(() => {
    setLoading(true);
    setPage(0);
    fetchCrossRepoFeatures(repo, { search: debouncedSearch || undefined })
      .then((data) =>
        setFlags(Array.isArray(data?.flags) ? data.flags.filter(isSharedFlag) : [])
      )
      .catch(() => setFlags([]))
      .finally(() => setLoading(false));
  }, [repo, debouncedSearch]);

  const sorted = useMemo(() => {
    const arr = [...flags];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortKey === 'repoCount') cmp = a.repos.length - b.repos.length;
      else if (sortKey === 'coordinated') cmp = (a.coordinated ? 1 : 0) - (b.coordinated ? 1 : 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [flags, sortKey, sortDir]);

  const paged = useMemo(() => sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [sorted, page]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  function SortIndicator({ k }: { k: SortKey }) {
    if (sortKey !== k) return <span className="ml-1 text-slate-300">↕</span>;
    return <span className="ml-1">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  }

  const coordinated = flags.filter((f) => f.coordinated).length;
  const uncoordinated = flags.length - coordinated;
  const start = page * PAGE_SIZE + 1;
  const end = Math.min((page + 1) * PAGE_SIZE, sorted.length);

  if (loading) return (
    <div className="p-8 text-center text-slate-500 dark:text-slate-400 animate-pulse">
      <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-48 mx-auto mb-2" />
      <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-32 mx-auto" />
    </div>
  );

  if (flags.length === 0) {
    return <p className="text-slate-500 dark:text-slate-400 text-center py-12">No shared feature flags detected across repos. Feature flags shared across 2+ repos will appear here.</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {flags.length} shared flags ({coordinated} coordinated, {uncoordinated} uncoordinated)
        </p>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search flags..."
          className="border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 w-56"
        />
      </div>
      <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
            <tr>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('name')}
              >
                Flag Name<SortIndicator k="name" />
              </th>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('repoCount')}
              >
                Repos<SortIndicator k="repoCount" />
              </th>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('coordinated')}
              >
                Status<SortIndicator k="coordinated" />
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.map((f, i) => (
              <tr key={f.name} className={i % 2 === 0 ? 'bg-white dark:bg-slate-800' : 'bg-slate-50 dark:bg-slate-900/50'}>
                <td className="px-3 py-1.5 font-mono text-xs text-slate-700 dark:text-slate-300 max-w-[200px] truncate" title={f.name}>{f.name}</td>
                <td className="px-3 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {f.repos.map((r) => (
                      <span key={r} className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                        {r}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-1.5">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    f.coordinated
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                  }`}>
                    {f.coordinated ? 'Coordinated' : 'Uncoordinated'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {sorted.length > PAGE_SIZE && (
          <div className="px-4 py-3 border-t dark:border-slate-700 flex items-center justify-between text-sm text-slate-600 dark:text-slate-400">
            <span>{start}–{end} of {sorted.length}</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => p - 1)}
                disabled={page === 0}
                className="px-3 py-1 rounded border dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Prev
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={end >= sorted.length}
                className="px-3 py-1 rounded border dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
      <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
        Flags appearing in 2+ repos. Uncoordinated flags have no dependency edge between sharing repos.
      </p>
    </div>
  );
}

// ── All Flags view ───────────────────────────────────────────────────────────

function AllFlagsView({ repo }: { repo?: string }) {
  const [flags, setFlags] = useState<RepoFlag[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<AllFlagsSortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { setDebouncedSearch(search); setPage(0); }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  useEffect(() => {
    setPage(0);
    setSearch('');
    setDebouncedSearch('');
  }, [repo]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchRepoFlags(repo, debouncedSearch || undefined, { limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((data) => {
        if (cancelled) return;
        setFlags(Array.isArray(data.flags) ? data.flags : []);
        setTotal(data.total ?? 0);
      })
      .catch(() => {
        if (cancelled) return;
        setFlags([]);
        setTotal(0);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repo, page, debouncedSearch]);

  const sorted = useMemo(() => {
    const arr = [...flags];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortKey === 'repo') cmp = a.repo.localeCompare(b.repo);
      else if (sortKey === 'source') cmp = a.source.localeCompare(b.source);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [flags, sortKey, sortDir]);

  function toggleSort(key: AllFlagsSortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  function SortIndicator({ k }: { k: AllFlagsSortKey }) {
    if (sortKey !== k) return <span className="ml-1 text-slate-300">↕</span>;
    return <span className="ml-1">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  }

  const start = page * PAGE_SIZE + 1;
  const end = Math.min((page + 1) * PAGE_SIZE, page * PAGE_SIZE + flags.length);

  if (loading) return (
    <div className="p-8 text-center text-slate-500 dark:text-slate-400 animate-pulse">
      <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-48 mx-auto mb-2" />
      <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-32 mx-auto" />
    </div>
  );

  if (total === 0 && !debouncedSearch) {
    return <p className="text-slate-500 dark:text-slate-400 text-center py-12">No per-repo flags found. Run <code className="font-mono text-xs bg-slate-100 dark:bg-slate-700 px-1 rounded">mma index</code> to detect feature flags.</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {total} flag occurrence{total !== 1 ? 's' : ''}
        </p>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search flags, repos, files..."
          className="border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 w-64"
        />
      </div>
      <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
            <tr>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('name')}
              >
                Flag Name<SortIndicator k="name" />
              </th>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('repo')}
              >
                Repo<SortIndicator k="repo" />
              </th>
              <th
                className="text-left px-3 py-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                onClick={() => toggleSort('source')}
              >
                Source<SortIndicator k="source" />
              </th>
              <th className="text-left px-3 py-2 text-slate-700 dark:text-slate-300">
                File
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((f, i) => (
              <tr key={`${f.repo}-${f.name}-${f.file ?? ''}-${i}`} className={i % 2 === 0 ? 'bg-white dark:bg-slate-800' : 'bg-slate-50 dark:bg-slate-900/50'}>
                <td className="px-3 py-1.5 font-mono text-xs text-slate-700 dark:text-slate-300 max-w-[200px] truncate" title={f.name}>{f.name}</td>
                <td className="px-3 py-1.5">
                  <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                    {f.repo}
                  </span>
                </td>
                <td className="px-3 py-1.5">
                  <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300">
                    {f.source}
                  </span>
                </td>
                <td className="px-3 py-1.5 font-mono text-xs text-slate-500 dark:text-slate-400 max-w-xs truncate" title={f.file}>
                  {f.file ? (
                    <span>
                      {f.file.split('/').slice(-2).join('/')}
                      {f.line !== undefined && <span className="text-slate-400 dark:text-slate-500">:{f.line}</span>}
                    </span>
                  ) : '-'}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && debouncedSearch && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-slate-400 dark:text-slate-500">
                  No flags match &ldquo;{debouncedSearch}&rdquo;
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {total > PAGE_SIZE && (
          <div className="px-4 py-3 border-t dark:border-slate-700 flex items-center justify-between text-sm text-slate-600 dark:text-slate-400">
            <span>{start}–{end} of {total}</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => p - 1)}
                disabled={page === 0}
                className="px-3 py-1 rounded border dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Prev
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={end >= total}
                className="px-3 py-1 rounded border dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
      <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
        All flags detected per-repo from static analysis. Each row is one flag occurrence in one file.
      </p>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function FeatureFlagsTable({ repo }: Props) {
  const [activeTab, setActiveTab] = useState<ViewTab>('shared');

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Feature Flags</h2>
        <div className="inline-flex rounded-lg border border-slate-300 dark:border-slate-600 overflow-hidden">
          <button
            onClick={() => setActiveTab('shared')}
            className={`px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === 'shared'
                ? 'bg-blue-600 text-white'
                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}
          >
            Shared Flags
          </button>
          <button
            onClick={() => setActiveTab('all')}
            className={`px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === 'all'
                ? 'bg-blue-600 text-white'
                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}
          >
            All Flags
          </button>
        </div>
      </div>

      {activeTab === 'shared' && <SharedFlagsView repo={repo} />}
      {activeTab === 'all' && <AllFlagsView repo={repo} />}
    </div>
  );
}
