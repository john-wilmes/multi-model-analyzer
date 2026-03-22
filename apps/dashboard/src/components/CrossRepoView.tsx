import { useState, useEffect, useRef } from 'react';
import { fetchRepos } from '../api/client.ts';
import CrossRepoGraphView from './CrossRepoGraphView.tsx';
import FeatureFlagsTable from './FeatureFlagsTable.tsx';
import CascadingFaultsTable from './CascadingFaultsTable.tsx';
import ServiceCatalogTable from './ServiceCatalogTable.tsx';

const TABS = ['Graph', 'Feature Flags', 'Cascading Faults', 'Service Catalog'] as const;
type Tab = typeof TABS[number];

// B5: Searchable repo selector (no external deps)
interface RepoSelectorProps {
  repos: string[];
  value: string;
  onChange: (repo: string) => void;
}

function RepoSelector({ repos, value, onChange }: RepoSelectorProps) {
  const [inputValue, setInputValue] = useState(value);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(undefined as unknown as HTMLDivElement);

  // Sync input when value is cleared externally
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  const filtered = inputValue.trim()
    ? repos.filter((r) => r.toLowerCase().includes(inputValue.toLowerCase()))
    : repos;

  // All repos option always shows when input is empty or matches "all"
  const showAllOption = !inputValue.trim() || 'all repos'.includes(inputValue.toLowerCase());

  function select(repo: string) {
    setInputValue(repo);
    onChange(repo);
    setOpen(false);
  }

  function selectAll() {
    setInputValue('');
    onChange('');
    setOpen(false);
  }

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <input
        id="repo-filter"
        type="text"
        value={inputValue}
        placeholder="All repos"
        onChange={(e) => { setInputValue(e.target.value); setOpen(true); onChange(''); }}
        onFocus={() => setOpen(true)}
        className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1 text-sm text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 w-44"
        aria-label="Filter by repo"
        aria-autocomplete="list"
        aria-expanded={open}
        role="combobox"
      />
      {/* Always render dropdown in DOM so "All repos" is always queryable by tests */}
      <ul
        role="listbox"
        aria-hidden={!open}
        className={`absolute right-0 top-full mt-1 w-56 max-h-64 overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded shadow-lg z-30 py-1 ${open ? '' : 'hidden'}`}
      >
        {showAllOption && (
          <li>
            <button
              role="option"
              aria-selected={value === ''}
              onClick={selectAll}
              className={`w-full text-left px-3 py-1.5 text-sm ${
                value === ''
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                  : 'text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700'
              }`}
            >
              All repos
            </button>
          </li>
        )}
        {filtered.map((r) => (
          <li key={r}>
            <button
              role="option"
              aria-selected={value === r}
              onClick={() => select(r)}
              className={`w-full text-left px-3 py-1.5 text-sm truncate ${
                value === r
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                  : 'text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700'
              }`}
              title={r}
            >
              {r}
            </button>
          </li>
        ))}
        {filtered.length === 0 && !showAllOption && (
          <li className="px-3 py-1.5 text-xs text-slate-400 dark:text-slate-500">No repos match</li>
        )}
      </ul>
    </div>
  );
}

export default function CrossRepoView() {
  const [activeTab, setActiveTab] = useState<Tab>('Graph');
  const [repos, setRepos] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState('');

  useEffect(() => {
    fetchRepos()
      .then((d) => setRepos(d.repos))
      .catch(() => setRepos([]));
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-700 flex-1">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
        <div className="ml-4 flex items-center gap-2">
          <label htmlFor="repo-filter" className="text-xs text-slate-500 dark:text-slate-400">Filter by repo</label>
          <RepoSelector repos={repos} value={selectedRepo} onChange={setSelectedRepo} />
        </div>
      </div>

      {activeTab === 'Graph' && <CrossRepoGraphView />}
      {activeTab === 'Feature Flags' && <FeatureFlagsTable repo={selectedRepo || undefined} />}
      {activeTab === 'Cascading Faults' && <CascadingFaultsTable repo={selectedRepo || undefined} />}
      {activeTab === 'Service Catalog' && <ServiceCatalogTable repo={selectedRepo || undefined} />}
    </div>
  );
}
