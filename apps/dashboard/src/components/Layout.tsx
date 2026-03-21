import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { fetchRepos } from '../api/client.ts';

// ---------------------------------------------------------------------------
// SVG Icons (22×22, viewBox 0 0 24 24)
// ---------------------------------------------------------------------------

function IconGrid() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="1" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1" y="10" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="10" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M9 2L16.5 15H1.5L9 2Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <line x1="9" y1="7" x2="9" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="9" cy="13" r="0.75" fill="currentColor" />
    </svg>
  );
}

function IconNetwork() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="3" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="15" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="3" cy="14" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="15" cy="14" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="4.2" y1="5" x2="7.5" y2="7.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="13.8" y1="5" x2="10.5" y2="7.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="4.2" y1="13" x2="7.5" y2="10.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="13.8" y1="13" x2="10.5" y2="10.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5" />
      <polyline points="9,5 9,9 12,11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconTarget() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="9" cy="9" r="4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="9" cy="9" r="1.5" fill="currentColor" />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M2 5a1 1 0 011-1h4l2 2h6a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconChevronLeft() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <polyline points="11,4 6,9 11,14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <polyline points="7,4 12,9 7,14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSun() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function IconMoon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumb helpers
// ---------------------------------------------------------------------------

interface BreadcrumbSegment {
  label: string;
  to: string | null; // null = current (last) segment, no link
}

function useBreadcrumbs(): BreadcrumbSegment[] {
  const location = useLocation();
  const pathname = location.pathname;

  // "/" → no breadcrumbs beyond root
  if (pathname === '/') return [];

  const segments: BreadcrumbSegment[] = [];

  // /findings
  if (pathname === '/findings') {
    segments.push({ label: 'Findings', to: null });
    return segments;
  }

  // /cross-repo
  if (pathname === '/cross-repo') {
    segments.push({ label: 'Cross-Repo', to: null });
    return segments;
  }

  // /temporal-coupling
  if (pathname === '/temporal-coupling') {
    segments.push({ label: 'Temporal Coupling', to: null });
    return segments;
  }

  // /blast-radius/:name
  const blastMatch = pathname.match(/^\/blast-radius\/(.+)$/);
  if (blastMatch) {
    const name = decodeURIComponent(blastMatch[1]);
    segments.push({ label: 'Blast Radius', to: '/blast-radius/' + blastMatch[1] });
    segments.push({ label: name, to: null });
    return segments;
  }

  // /graph/:name
  const graphMatch = pathname.match(/^\/graph\/(.+)$/);
  if (graphMatch) {
    const name = decodeURIComponent(graphMatch[1]);
    segments.push({ label: name, to: `/repo/${graphMatch[1]}` });
    segments.push({ label: 'Dependency Graph', to: null });
    return segments;
  }

  // /repo/:name/module/*
  const moduleMatch = pathname.match(/^\/repo\/([^/]+)\/module\/(.+)$/);
  if (moduleMatch) {
    const repoName = decodeURIComponent(moduleMatch[1]);
    const modulePath = decodeURIComponent(moduleMatch[2]);
    segments.push({ label: repoName, to: `/repo/${moduleMatch[1]}` });
    segments.push({ label: modulePath, to: null });
    return segments;
  }

  // /repo/:name
  const repoMatch = pathname.match(/^\/repo\/([^/]+)$/);
  if (repoMatch) {
    const name = decodeURIComponent(repoMatch[1]);
    segments.push({ label: name, to: null });
    return segments;
  }

  return segments;
}

function usePageTitle(breadcrumbs: BreadcrumbSegment[]) {
  const location = useLocation();
  useEffect(() => {
    const last = breadcrumbs[breadcrumbs.length - 1];
    const pageName = last ? last.label : 'Overview';
    document.title = `${pageName} — MMA Dashboard`;
  }, [location.pathname, breadcrumbs]);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export default function Layout() {
  const [repos, setRepos] = useState<string[]>([]);
  const location = useLocation();

  // Sidebar collapsed state — persisted
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mma-sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });

  // Dark mode state — persisted + respects OS preference, defaults to dark
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    // 1. Check localStorage
    try {
      const stored = localStorage.getItem('mma-dark-mode');
      if (stored !== null) {
        const isDark = stored === 'true';
        // Apply immediately to avoid flash of wrong theme
        if (isDark) {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
        return isDark;
      }
    } catch {
      // ignore
    }
    // 2. Default to dark mode when no explicit user preference
    document.documentElement.classList.add('dark');
    return true;
  });

  // Apply dark class to <html>
  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    try {
      localStorage.setItem('mma-dark-mode', String(darkMode));
    } catch {
      // ignore
    }
  }, [darkMode]);

  // Persist sidebar collapsed state
  useEffect(() => {
    try {
      localStorage.setItem('mma-sidebar-collapsed', String(collapsed));
    } catch {
      // ignore
    }
  }, [collapsed]);

  useEffect(() => {
    fetchRepos()
      .then((data) => setRepos(data.repos))
      .catch(() => setRepos([]));
  }, []);

  const breadcrumbs = useBreadcrumbs();
  usePageTitle(breadcrumbs);

  function navClass(path: string, prefix = false) {
    const active = prefix ? location.pathname.startsWith(path) : location.pathname === path;
    const base = 'flex items-center gap-2 rounded text-sm transition-colors';
    const activeClass = 'bg-slate-700 text-white';
    const inactiveClass = 'text-slate-300 hover:bg-slate-700 hover:text-white';
    const padding = collapsed ? 'px-0 py-2 justify-center' : 'px-3 py-2';
    return `${base} ${padding} ${active ? activeClass : inactiveClass}`;
  }

  const sidebarWidth = collapsed ? 'w-14' : 'w-56';
  const mainMargin = collapsed ? 'ml-14' : 'ml-56';

  return (
    <div className="flex min-h-screen bg-slate-50 dark:bg-slate-900">
      {/* Sidebar */}
      <aside
        className={`fixed left-0 top-0 h-full ${sidebarWidth} bg-slate-800 dark:bg-slate-950 flex flex-col overflow-hidden transition-all duration-200 z-20`}
      >
        {/* Header */}
        <div
          className={`flex items-center border-b border-slate-700 dark:border-slate-800 transition-all duration-200 ${
            collapsed ? 'px-0 py-4 justify-center' : 'px-4 py-4 justify-between'
          }`}
        >
          {collapsed ? (
            <div className="flex flex-col items-center gap-2">
              <span className="text-blue-400" title="MMA Dashboard">
                <IconGrid />
              </span>
              <button
                onClick={() => setDarkMode((d) => !d)}
                className="text-yellow-400 hover:text-yellow-300 transition-colors"
                title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {darkMode ? <IconSun /> : <IconMoon />}
              </button>
            </div>
          ) : (
            <>
              <h1 className="text-white font-semibold text-base truncate">MMA Dashboard</h1>
              <button
                onClick={() => setDarkMode((d) => !d)}
                className="text-yellow-400 hover:text-yellow-300 ml-2 flex-shrink-0"
                title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {darkMode ? <IconSun /> : <IconMoon />}
              </button>
            </>
          )}
        </div>

        {/* Nav */}
        <nav className={`flex-1 py-4 space-y-1 overflow-y-auto ${collapsed ? 'px-2' : 'px-3'}`}>
          <Link to="/" className={navClass('/')} title={collapsed ? 'Overview' : undefined}>
            <IconGrid />
            {!collapsed && <span>Overview</span>}
          </Link>

          <Link to="/findings" className={navClass('/findings')} title={collapsed ? 'Findings' : undefined}>
            <IconAlert />
            {!collapsed && <span>Findings</span>}
          </Link>

          <Link to="/cross-repo" className={navClass('/cross-repo')} title={collapsed ? 'Cross-Repo Graph' : undefined}>
            <IconNetwork />
            {!collapsed && <span>Cross-Repo Graph</span>}
          </Link>

          <Link
            to="/temporal-coupling"
            className={navClass('/temporal-coupling')}
            title={collapsed ? 'Temporal Coupling' : undefined}
          >
            <IconClock />
            {!collapsed && <span>Temporal Coupling</span>}
          </Link>

          {repos[0] ? (
            <Link
              to={`/blast-radius/${encodeURIComponent(repos[0])}`}
              className={navClass('/blast-radius', true)}
              title={collapsed ? 'Blast Radius' : undefined}
            >
              <IconTarget />
              {!collapsed && <span>Blast Radius</span>}
            </Link>
          ) : (
            <span
              className={`flex items-center gap-2 rounded text-sm text-slate-500 ${collapsed ? 'px-0 py-2 justify-center' : 'px-3 py-2'}`}
              title={collapsed ? 'Blast Radius' : undefined}
            >
              <IconTarget />
              {!collapsed && <span>Blast Radius</span>}
            </span>
          )}

          {/* Repos section */}
          {repos.length > 0 && (
            <div className="mt-4">
              {collapsed ? (
                <div className="flex justify-center py-2 text-slate-500" title="Repos">
                  <IconFolder />
                </div>
              ) : (
                <>
                  <p className="px-3 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                    Repos
                  </p>
                  {repos.map((repo) => (
                    <Link
                      key={repo}
                      to={`/repo/${encodeURIComponent(repo)}`}
                      className={navClass(`/repo/${encodeURIComponent(repo)}`)}
                    >
                      <span className="truncate">{repo}</span>
                    </Link>
                  ))}
                </>
              )}
            </div>
          )}
        </nav>

        {/* Collapse toggle */}
        <div className={`border-t border-slate-700 dark:border-slate-800 ${collapsed ? 'px-2 py-3 flex justify-center' : 'px-3 py-3'}`}>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className={`flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors ${
              collapsed ? 'justify-center w-full' : 'px-2 py-1 rounded hover:bg-slate-700 w-full'
            }`}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <IconChevronRight /> : (
              <>
                <IconChevronLeft />
                <span>Collapse</span>
              </>
            )}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className={`${mainMargin} flex-1 p-6 transition-all duration-200`}>
        {breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400 mb-4 flex-wrap">
            <Link
              to="/"
              className="hover:underline text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              Overview
            </Link>
            {breadcrumbs.map((seg, i) => {
              const isLast = i === breadcrumbs.length - 1;
              return (
                <span key={i} className="flex items-center gap-1">
                  <span className="text-slate-300 dark:text-slate-600 select-none">/</span>
                  {isLast || seg.to === null ? (
                    <span className="text-slate-800 dark:text-slate-200 font-medium">{seg.label}</span>
                  ) : (
                    <Link
                      to={seg.to}
                      className="hover:underline text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    >
                      {seg.label}
                    </Link>
                  )}
                </span>
              );
            })}
          </nav>
        )}
        <Outlet />
      </main>
    </div>
  );
}
