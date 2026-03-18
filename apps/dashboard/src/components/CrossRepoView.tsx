import { useState } from 'react';
import CrossRepoGraphView from './CrossRepoGraphView.tsx';
import FeatureFlagsTable from './FeatureFlagsTable.tsx';
import CascadingFaultsTable from './CascadingFaultsTable.tsx';
import ServiceCatalogTable from './ServiceCatalogTable.tsx';

const TABS = ['Graph', 'Feature Flags', 'Cascading Faults', 'Service Catalog'] as const;
type Tab = typeof TABS[number];

export default function CrossRepoView() {
  const [activeTab, setActiveTab] = useState<Tab>('Graph');

  return (
    <div>
      <div className="flex items-center gap-1 mb-6 border-b border-slate-200">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'Graph' && <CrossRepoGraphView />}
      {activeTab === 'Feature Flags' && <FeatureFlagsTable />}
      {activeTab === 'Cascading Faults' && <CascadingFaultsTable />}
      {activeTab === 'Service Catalog' && <ServiceCatalogTable />}
    </div>
  );
}
