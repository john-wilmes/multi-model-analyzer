// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RepoDetail from './RepoDetail.tsx';

// Mock Recharts
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScatterChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Scatter: () => <div />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  ZAxis: () => <div />,
  Tooltip: () => <div />,
  CartesianGrid: () => <div />,
  ReferenceLine: () => <div />,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => <div />,
  Cell: () => <div />,
  Legend: () => <div />,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: () => <div />,
}));

const mockMetrics = [
  { module: 'src/a.ts', instability: 0.6, abstractness: 0.2 },
  { module: 'src/b.ts', instability: 0.3, abstractness: 0.7 },
];
const mockFindings = {
  results: [
    { ruleId: 'MMA001', level: 'error', message: 'Test finding' },
  ],
  total: 1,
};
const mockDsm = { modules: [], matrix: [], edgeKind: 'imports' };
const mockAtdi = {
  repo: 'my-repo',
  score: 75,
  moduleCount: 10,
  components: { findingsDensity: 0.1, zoneRatio: 0.2, avgDistance: 0.3 },
  findingCounts: { error: 2, warning: 5, note: 8 },
};
const mockDebt = {
  repo: 'my-repo',
  totalMinutes: 120,
  totalHours: 2,
  byRule: { 'MMA001': { count: 3, minutes: 60 } },
  bySeverity: {},
};
const mockCoupling = { pairs: [], commitsAnalyzed: 0, commitsSkipped: 0 };

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function setupFetchMock() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/metrics/')) return jsonResponse(mockMetrics);
    if (url.includes('/api/findings')) return jsonResponse(mockFindings);
    if (url.includes('/api/dsm/')) return jsonResponse(mockDsm);
    if (url.includes('/api/atdi/')) return jsonResponse(mockAtdi);
    if (url.includes('/api/debt/')) return jsonResponse(mockDebt);
    if (url.includes('/api/temporal-coupling/')) return jsonResponse(mockCoupling);
    return jsonResponse({});
  }));
}

function renderWithRoute() {
  return render(
    <MemoryRouter initialEntries={['/repo/my-repo']}>
      <Routes>
        <Route path="/repo/:name" element={<RepoDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  setupFetchMock();
});

describe('RepoDetail', () => {
  it('renders loading state initially', () => {
    const { container } = renderWithRoute();
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders repo name as heading', async () => {
    renderWithRoute();
    expect(await screen.findByText('my-repo')).toBeInTheDocument();
  });

  it('renders summary cards', async () => {
    renderWithRoute();
    expect(await screen.findByText('Total modules')).toBeInTheDocument();
    expect(screen.getByText('Avg instability')).toBeInTheDocument();
    expect(screen.getByText('Avg abstractness')).toBeInTheDocument();
    expect(screen.getByText('Pain zone')).toBeInTheDocument();
  });

  it('renders total module count', async () => {
    renderWithRoute();
    // Two modules in mockMetrics
    expect(await screen.findByText('2')).toBeInTheDocument();
  });

  it('renders ATDI score section', async () => {
    renderWithRoute();
    expect(await screen.findByText('ATDI Score')).toBeInTheDocument();
  });

  it('renders technical debt section', async () => {
    renderWithRoute();
    expect(await screen.findByText('Technical Debt')).toBeInTheDocument();
    expect(screen.getByText('2h')).toBeInTheDocument();
  });

  it('renders top findings table', async () => {
    renderWithRoute();
    expect(await screen.findByText('Top Findings')).toBeInTheDocument();
    expect(screen.getByText('MMA001')).toBeInTheDocument();
    expect(screen.getByText('Test finding')).toBeInTheDocument();
  });

  it('renders view all link', async () => {
    renderWithRoute();
    expect(await screen.findByText('View all')).toBeInTheDocument();
  });

  it('renders dependency graph link', async () => {
    renderWithRoute();
    const link = await screen.findByText(/View dependency graph/);
    expect(link).toBeInTheDocument();
  });
});
