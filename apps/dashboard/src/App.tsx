import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.tsx';
import Overview from './components/Overview.tsx';
import RepoDetail from './components/RepoDetail.tsx';
import ModuleDetail from './components/ModuleDetail.tsx';
import FindingsTable from './components/FindingsTable.tsx';
import DependencyGraph from './components/DependencyGraph.tsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Overview />} />
          <Route path="/repo/:name" element={<RepoDetail />} />
          {/* Use * catch-all for module path since paths contain slashes */}
          <Route path="/repo/:name/module/*" element={<ModuleDetail />} />
          <Route path="/findings" element={<FindingsTable />} />
          <Route path="/graph/:name" element={<DependencyGraph />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
