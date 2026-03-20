import { useState, useEffect } from 'react';
import { fetchRepos } from '../api/client.ts';
import CrossRepoGraphView from './CrossRepoGraphView.tsx';
import FeatureFlagsTable from './FeatureFlagsTable.tsx';
import CascadingFaultsTable from './CascadingFaultsTable.tsx';
import ServiceCatalogTable from './ServiceCatalogTable.tsx';

const TABS = ['Graph', 'Feature Flags', 'Cascading Faults', 'Service Catalog'] as const;
type Tab = typeof TABS[number];

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
          <select
            id="repo-filter"
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1 text-sm text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All repos</option>
            {repos.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
      </div>

      {activeTab === 'Graph' && <CrossRepoGraphView />}
      {activeTab === 'Feature Flags' && <FeatureFlagsTable repo={selectedRepo || undefined} />}
      {activeTab === 'Cascading Faults' && <CascadingFaultsTable repo={selectedRepo || undefined} />}
      {activeTab === 'Service Catalog' && <ServiceCatalogTable repo={selectedRepo || undefined} />}
    </div>
  );
}
