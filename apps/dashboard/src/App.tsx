import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.tsx';
import Overview from './components/Overview.tsx';
import RepoDetail from './components/RepoDetail.tsx';
import ModuleDetail from './components/ModuleDetail.tsx';
import FindingsTable from './components/FindingsTable.tsx';
import DependencyGraph from './components/DependencyGraph.tsx';
import BlastRadius from './components/BlastRadius.tsx';
import CrossRepoView from './components/CrossRepoView.tsx';
import TemporalCouplingView from './views/TemporalCouplingView.tsx';
import HotspotsView from './views/HotspotsView.tsx';
import PatternsView from './views/PatternsView.tsx';
import ConstraintsView from './views/ConstraintsView.tsx';
import ConstraintDetailView from './views/ConstraintDetailView.tsx';
import CrossEntityView from './views/CrossEntityView.tsx';
import ConfigValidatorView from './views/ConfigValidatorView.tsx';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error('Dashboard error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 text-center">
          <h1 className="text-2xl font-bold text-red-700 mb-2">Something went wrong</h1>
          <p className="text-slate-600 mb-4">Check the browser console for details.</p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Overview />} />
            <Route path="/repo/:name" element={<RepoDetail />} />
            {/* Use * catch-all for module path since paths contain slashes */}
            <Route path="/repo/:name/module/*" element={<ModuleDetail />} />
            <Route path="/findings" element={<FindingsTable />} />
            <Route path="/graph/:name" element={<DependencyGraph />} />
            <Route path="/blast-radius/:name" element={<BlastRadius />} />
            <Route path="/cross-repo" element={<CrossRepoView />} />
            <Route path="/temporal-coupling" element={<TemporalCouplingView />} />
            <Route path="/hotspots" element={<HotspotsView />} />
            <Route path="/patterns" element={<PatternsView />} />
            <Route path="/constraints" element={<ConstraintsView />} />
            <Route path="/constraints/:type" element={<ConstraintDetailView />} />
            <Route path="/cross-entity" element={<CrossEntityView />} />
            <Route path="/validate" element={<ConfigValidatorView />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
