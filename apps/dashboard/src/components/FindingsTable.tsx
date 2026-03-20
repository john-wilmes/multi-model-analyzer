import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchFindings, fetchRepos } from '../api/client.ts';
import { SeverityBadge } from './shared/SeverityBadge.tsx';

interface Finding {
  ruleId?: string;
  level?: string;
  message?: string | { text?: string };
  location?: string;
  repo?: string;
  locations?: Array<{
    logicalLocations?: Array<{
      fullyQualifiedName?: string;
    }>;
  }>;
  fingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
}

type ViewMode = 'flat' | 'by-rule';

const PAGE_SIZE = 25;

const SEVERITY_LEVELS = ['error', 'warning', 'note'] as const;

const VIEW_MODE_KEY = 'mma-findings-view';

function getStoredViewMode(): ViewMode {
  try {
    const stored = localStorage.getItem(VIEW_MODE_KEY);
    if (stored === 'flat' || stored === 'by-rule') return stored;
  } catch {
    // ignore
  }
  return 'flat';
}

function getLocation(f: Finding): string {
  return f.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName ?? '-';
}

function getMessage(f: Finding): string {
  if (typeof f.message === 'object' && f.message !== null) {
    return (f.message as { text?: string }).text ?? '-';
  }
  return (f.message as string | undefined) ?? '-';
}

interface RuleGroup {
  ruleId: string;
  level: string;
  count: number;
  findings: Finding[];
}

function groupByRule(findings: Finding[]): RuleGroup[] {
  const map = new Map<string, RuleGroup>();
  for (const f of findings) {
    const key = f.ruleId ?? '(unknown)';
    const existing = map.get(key);
    if (existing) {
      existing.count++;
      existing.findings.push(f);
    } else {
      map.set(key, {
        ruleId: key,
        level: f.level ?? 'note',
        count: 1,
        findings: [f],
      });
    }
  }
  // Sort by count descending
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export default function FindingsTable() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [repos, setRepos] = useState<string[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>(getStoredViewMode);
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const repo = searchParams.get('repo') ?? '';
  const severities = searchParams.getAll('severity');
  const rule = searchParams.get('rule') ?? '';
  const page = parseInt(searchParams.get('page') ?? '0', 10);

  const [ruleInput, setRuleInput] = useState(rule);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    setRuleInput(rule);
  }, [rule]);
  useEffect(() => {
    if (ruleInput === rule) return;
    debounceRef.current = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (ruleInput) next.set('rule', ruleInput);
      else next.delete('rule');
      next.delete('page');
      setSearchParams(next);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [ruleInput, rule, searchParams, setSearchParams]);

  const load = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (viewMode === 'flat') {
      qs.set('offset', String(page * PAGE_SIZE));
      qs.set('limit', String(PAGE_SIZE));
    } else {
      // Fetch all for group-by-rule mode
      qs.set('offset', '0');
      qs.set('limit', '9999');
    }
    if (repo) qs.set('repo', repo);
    if (rule) qs.set('rule', rule);
    severities.forEach((s) => qs.append('level', s));

    fetchFindings(qs)
      .then((data) => {
        setFindings((data.results ?? []) as Finding[]);
        setTotal(data.total ?? 0);
      })
      .catch((err: unknown) => console.error('Failed to fetch findings:', err))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, rule, page, severities.join(','), viewMode]);

  useEffect(() => {
    fetchRepos()
      .then((d) => setRepos(d.repos))
      .catch((err: unknown) => console.error('Failed to fetch repos:', err));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setSearchParams(next);
  }

  function toggleSeverity(level: string) {
    const next = new URLSearchParams(searchParams);
    const current = next.getAll('severity');
    if (current.includes(level)) {
      next.delete('severity');
      current
        .filter((s) => s !== level)
        .forEach((s) => next.append('severity', s));
    } else {
      next.append('severity', level);
    }
    next.delete('page');
    setSearchParams(next);
  }

  function setPage(p: number) {
    const next = new URLSearchParams(searchParams);
    if (p === 0) next.delete('page');
    else next.set('page', String(p));
    setSearchParams(next);
  }

  function switchViewMode(mode: ViewMode) {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      // ignore
    }
    // Reset pagination when switching modes
    const next = new URLSearchParams(searchParams);
    next.delete('page');
    setSearchParams(next);
    setExpandedRules(new Set());
    setExpandedRow(null);
  }

  function toggleRule(ruleId: string) {
    setExpandedRules((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  }

  function toggleRow(index: number) {
    setExpandedRow((prev) => (prev === index ? null : index));
  }

  const start = page * PAGE_SIZE + 1;
  const end = Math.min((page + 1) * PAGE_SIZE, total);

  const ruleGroups = viewMode === 'by-rule' ? groupByRule(findings) : [];

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Findings</h2>

      {/* Filters */}
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 p-4 flex flex-wrap gap-4 items-end">
        {/* Repo filter */}
        <div>
          <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Repo</label>
          <select
            value={repo}
            onChange={(e) => setParam('repo', e.target.value)}
            className="border dark:border-slate-600 rounded px-2 py-1 text-sm text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All repos</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        {/* Severity checkboxes */}
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">Severity</p>
          <div className="flex gap-3">
            {SEVERITY_LEVELS.map((level) => (
              <label key={level} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={severities.includes(level)}
                  onChange={() => toggleSeverity(level)}
                  className="rounded"
                />
                <SeverityBadge severity={level} />
              </label>
            ))}
          </div>
        </div>

        {/* Rule filter */}
        <div>
          <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Rule ID</label>
          <input
            type="text"
            value={ruleInput}
            onChange={(e) => setRuleInput(e.target.value)}
            placeholder="e.g. MMA001"
            className="border dark:border-slate-600 rounded px-2 py-1 text-sm text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-700 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 w-36"
          />
        </div>

        {/* View mode toggle */}
        <div className="ml-auto">
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">View</p>
          <div className="inline-flex rounded-lg border dark:border-slate-600 overflow-hidden">
            <button
              onClick={() => switchViewMode('flat')}
              className={`px-3 py-1 text-sm font-medium transition-colors ${
                viewMode === 'flat'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700'
              }`}
            >
              Flat
            </button>
            <button
              onClick={() => switchViewMode('by-rule')}
              className={`px-3 py-1 text-sm font-medium transition-colors ${
                viewMode === 'by-rule'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700'
              }`}
            >
              By Rule
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      {viewMode === 'flat' ? (
        /* Flat table */
        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 overflow-hidden">
          {loading ? (
            <p className="p-4 text-slate-500 dark:text-slate-400 text-sm">Loading...</p>
          ) : findings.length === 0 ? (
            <p className="p-4 text-slate-500 dark:text-slate-400 text-sm">No findings found.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900 border-b dark:border-slate-700">
                <tr className="text-left text-xs text-slate-500 dark:text-slate-300">
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3">Rule ID</th>
                  <th className="px-4 py-3">Message</th>
                  <th className="px-4 py-3">Location</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f, i) => {
                  const isExpanded = expandedRow === i;
                  const fingerprint = f.fingerprints?.['mma/v1'] ?? f.fingerprints?.['primaryLocationLineHash/v1'];
                  const extraProps = f.properties
                    ? Object.entries(f.properties).filter(([, v]) => v !== undefined && v !== null)
                    : [];
                  return (
                    <React.Fragment key={i}>
                      <tr
                        onClick={() => toggleRow(i)}
                        className={`border-b dark:border-slate-700 last:border-0 cursor-pointer select-none transition-colors ${
                          isExpanded
                            ? 'bg-blue-50 dark:bg-slate-700'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-700'
                        }`}
                      >
                        <td className="px-4 py-3">
                          <SeverityBadge severity={f.level} />
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                          {f.ruleId ?? '-'}
                        </td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300 max-w-sm truncate">
                          {getMessage(f)}
                        </td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400 text-xs font-mono max-w-xs truncate">
                          {getLocation(f)}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${i}-detail`} className="border-b dark:border-slate-700">
                          <td colSpan={4} className="bg-slate-50 dark:bg-slate-900 border-t dark:border-slate-700 px-6 py-4">
                            <div className="space-y-2 text-sm">
                              <div>
                                <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Message</span>
                                <p className="mt-0.5 text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words">{getMessage(f)}</p>
                              </div>
                              <div className="flex flex-wrap gap-4">
                                <div>
                                  <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Rule ID</span>
                                  <p className="mt-0.5 font-mono text-xs text-slate-600 dark:text-slate-300">{f.ruleId ?? '-'}</p>
                                </div>
                                <div>
                                  <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Severity</span>
                                  <div className="mt-0.5"><SeverityBadge severity={f.level} /></div>
                                </div>
                              </div>
                              <div>
                                <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Location</span>
                                <p className="mt-0.5 font-mono text-xs text-slate-600 dark:text-slate-300 break-all">{getLocation(f)}</p>
                              </div>
                              {fingerprint && (
                                <div>
                                  <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Fingerprint</span>
                                  <p className="mt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400 break-all">{fingerprint}</p>
                                </div>
                              )}
                              {extraProps.length > 0 && (
                                <div>
                                  <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Properties</span>
                                  <dl className="mt-0.5 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
                                    {extraProps.map(([k, v]) => (
                                      <React.Fragment key={k}>
                                        <dt className="text-slate-500 dark:text-slate-400 font-medium">{k}</dt>
                                        <dd className="text-slate-700 dark:text-slate-300 font-mono truncate">{String(v)}</dd>
                                      </React.Fragment>
                                    ))}
                                  </dl>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Pagination */}
          {total > 0 && (
            <div className="px-4 py-3 border-t dark:border-slate-700 flex items-center justify-between text-sm text-slate-600 dark:text-slate-400">
              <span>
                {start}–{end} of {total}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(page - 1)}
                  disabled={page === 0}
                  className="px-3 py-1 rounded border dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed dark:text-slate-300"
                >
                  Prev
                </button>
                <button
                  onClick={() => setPage(page + 1)}
                  disabled={end >= total}
                  className="px-3 py-1 rounded border dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed dark:text-slate-300"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Group by Rule accordion */
        <div className="space-y-2">
          {loading ? (
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 p-4">
              <p className="text-slate-500 dark:text-slate-400 text-sm">Loading...</p>
            </div>
          ) : ruleGroups.length === 0 ? (
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 p-4">
              <p className="text-slate-500 dark:text-slate-400 text-sm">No findings found.</p>
            </div>
          ) : (
            ruleGroups.map((group) => {
              const isExpanded = expandedRules.has(group.ruleId);
              return (
                <div
                  key={group.ruleId}
                  className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 overflow-hidden"
                >
                  {/* Accordion header */}
                  <button
                    onClick={() => toggleRule(group.ruleId)}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors text-left"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-mono text-sm font-semibold text-slate-700 dark:text-slate-200 shrink-0">
                        {group.ruleId}
                      </span>
                      <SeverityBadge severity={group.level} />
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-4">
                      <span className="bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 text-xs font-semibold px-2 py-0.5 rounded-full">
                        {group.count}
                      </span>
                      <span className="text-slate-400 dark:text-slate-500 text-sm">
                        {isExpanded ? '▲' : '▼'}
                      </span>
                    </div>
                  </button>

                  {/* Expanded findings list */}
                  {isExpanded && (
                    <div className="border-t dark:border-slate-700">
                      {group.findings.map((f, i) => (
                        <div
                          key={i}
                          className="px-4 py-2 border-b dark:border-slate-700 last:border-0 text-sm hover:bg-slate-50 dark:hover:bg-slate-700"
                        >
                          <div className="text-slate-700 dark:text-slate-300 truncate max-w-2xl">
                            {getMessage(f)}
                          </div>
                          <div className="text-xs text-slate-400 dark:text-slate-500 font-mono mt-0.5 truncate">
                            {getLocation(f)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {total > 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400 text-right">
              {total} total findings · {ruleGroups.length} rules
            </p>
          )}
        </div>
      )}
    </div>
  );
}
