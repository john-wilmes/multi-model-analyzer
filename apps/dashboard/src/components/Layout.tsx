import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { fetchRepos } from '../api/client.ts';

export default function Layout() {
  const [repos, setRepos] = useState<string[]>([]);
  const location = useLocation();

  useEffect(() => {
    fetchRepos()
      .then((data) => setRepos(data.repos))
      .catch(() => setRepos([]));
  }, []);

  function navClass(path: string, prefix = false) {
    const active = prefix ? location.pathname.startsWith(path) : location.pathname === path;
    return `block px-3 py-2 rounded text-sm ${active ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-700 hover:text-white'}`;
  }

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Sidebar */}
      <aside className="fixed left-0 top-0 h-full w-56 bg-slate-800 flex flex-col overflow-y-auto">
        <div className="px-4 py-4 border-b border-slate-700">
          <h1 className="text-white font-semibold text-base">MMA Dashboard</h1>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          <Link to="/" className={navClass('/')}>
            Overview
          </Link>
          <Link to="/findings" className={navClass('/findings')}>
            Findings
          </Link>
          <Link to="/cross-repo" className={navClass('/cross-repo')}>
            Cross-Repo Graph
          </Link>
          <Link to="/temporal-coupling" className={navClass('/temporal-coupling')}>
            Temporal Coupling
          </Link>
          {repos[0] ? (
            <Link
              to={`/blast-radius/${encodeURIComponent(repos[0])}`}
              className={navClass('/blast-radius', true)}
            >
              Blast Radius
            </Link>
          ) : (
            <span className="block px-3 py-2 rounded text-sm text-slate-500">
              Blast Radius
            </span>
          )}
          {repos.length > 0 && (
            <div className="mt-4">
              <p className="px-3 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                Repos
              </p>
              {repos.map((repo) => (
                <Link
                  key={repo}
                  to={`/repo/${encodeURIComponent(repo)}`}
                  className={navClass(`/repo/${encodeURIComponent(repo)}`)}
                >
                  {repo}
                </Link>
              ))}
            </div>
          )}
        </nav>
      </aside>

      {/* Main content */}
      <main className="ml-56 flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
