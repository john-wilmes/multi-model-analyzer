import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock the api/client module before importing Layout
vi.mock('../../api/client.ts', () => ({
  fetchRepos: vi.fn(() => Promise.resolve({ repos: ['test-repo'] })),
  fetchFindings: vi.fn(() => Promise.resolve({ results: [], total: 0 })),
  fetchMetrics: vi.fn(() => Promise.resolve([])),
  fetchMetricsSummary: vi.fn(() => Promise.resolve({})),
  fetchHotspots: vi.fn(() => Promise.resolve([])),
  fetchAtdi: vi.fn(() => Promise.resolve(null)),
  fetchCrossRepoGraph: vi.fn(() =>
    Promise.resolve({ edges: [], repoPairs: [], downstreamMap: [], upstreamMap: [] }),
  ),
  fetchTemporalCoupling: vi.fn(() => Promise.resolve([])),
  fetchBlastRadiusOverview: vi.fn(() =>
    Promise.resolve({ repo: 'test-repo', files: [], totalNodes: 0 }),
  ),
}));

import Layout from '../Layout.tsx';

function renderAtPath(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Layout />
    </MemoryRouter>,
  );
}

// Helper: get the breadcrumb nav element
function getBreadcrumbNav() {
  return screen.getByLabelText('Breadcrumb');
}

describe('Layout breadcrumbs', () => {
  beforeEach(() => {
    document.title = '';
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not show breadcrumbs on root path /', async () => {
    renderAtPath('/');
    await waitFor(() => {
      expect(screen.queryByLabelText('Breadcrumb')).not.toBeInTheDocument();
    });
  });

  it('shows "Overview / Findings" on /findings', async () => {
    renderAtPath('/findings');
    await waitFor(() => {
      expect(getBreadcrumbNav()).toBeInTheDocument();
    });
    const nav = getBreadcrumbNav();
    expect(within(nav).getByText('Overview')).toBeInTheDocument();
    expect(within(nav).getByText('Findings')).toBeInTheDocument();
  });

  it('shows "Overview / repoName" on /repo/repoName', async () => {
    renderAtPath('/repo/my-repo');
    await waitFor(() => {
      expect(getBreadcrumbNav()).toBeInTheDocument();
    });
    const nav = getBreadcrumbNav();
    expect(within(nav).getByText('Overview')).toBeInTheDocument();
    expect(within(nav).getByText('my-repo')).toBeInTheDocument();
  });

  it('shows "Overview / repoName / modulePath" on /repo/repoName/module/src/foo.ts', async () => {
    renderAtPath('/repo/my-repo/module/src/foo.ts');
    await waitFor(() => {
      expect(getBreadcrumbNav()).toBeInTheDocument();
    });
    const nav = getBreadcrumbNav();
    expect(within(nav).getByText('Overview')).toBeInTheDocument();
    expect(within(nav).getByText('my-repo')).toBeInTheDocument();
    expect(within(nav).getByText('src/foo.ts')).toBeInTheDocument();
  });

  it('shows "Overview / Cross-Repo" on /cross-repo', async () => {
    renderAtPath('/cross-repo');
    await waitFor(() => {
      expect(getBreadcrumbNav()).toBeInTheDocument();
    });
    const nav = getBreadcrumbNav();
    expect(within(nav).getByText('Overview')).toBeInTheDocument();
    expect(within(nav).getByText('Cross-Repo')).toBeInTheDocument();
  });

  it('shows "Overview / Temporal Coupling" on /temporal-coupling', async () => {
    renderAtPath('/temporal-coupling');
    await waitFor(() => {
      expect(getBreadcrumbNav()).toBeInTheDocument();
    });
    const nav = getBreadcrumbNav();
    expect(within(nav).getByText('Overview')).toBeInTheDocument();
    expect(within(nav).getByText('Temporal Coupling')).toBeInTheDocument();
  });

  it('shows "Overview / Blast Radius / repoName" on /blast-radius/repoName', async () => {
    renderAtPath('/blast-radius/my-repo');
    await waitFor(() => {
      expect(getBreadcrumbNav()).toBeInTheDocument();
    });
    const nav = getBreadcrumbNav();
    expect(within(nav).getByText('Overview')).toBeInTheDocument();
    expect(within(nav).getByText('Blast Radius')).toBeInTheDocument();
    expect(within(nav).getByText('my-repo')).toBeInTheDocument();
  });

  it('shows "Overview / repoName / Dependency Graph" on /graph/repoName', async () => {
    renderAtPath('/graph/my-repo');
    await waitFor(() => {
      expect(getBreadcrumbNav()).toBeInTheDocument();
    });
    const nav = getBreadcrumbNav();
    expect(within(nav).getByText('Overview')).toBeInTheDocument();
    expect(within(nav).getByText('my-repo')).toBeInTheDocument();
    expect(within(nav).getByText('Dependency Graph')).toBeInTheDocument();
  });

  it('sets document.title based on route', async () => {
    renderAtPath('/findings');
    await waitFor(() => {
      expect(document.title).toBe('Findings — MMA Dashboard');
    });
  });

  it('sets document.title to Overview on root path', async () => {
    renderAtPath('/');
    await waitFor(() => {
      expect(document.title).toBe('Overview — MMA Dashboard');
    });
  });
});

describe('Layout sidebar', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('sidebar defaults to expanded (w-56) when no localStorage value', async () => {
    const { container } = renderAtPath('/');
    await waitFor(() => {
      const aside = container.querySelector('aside');
      expect(aside?.className).toContain('w-56');
    });
  });

  it('dark mode defaults to true (dark class on documentElement)', async () => {
    renderAtPath('/');
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
  });
});
