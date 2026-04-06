// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Overview from './Overview.tsx';

// Mock Recharts components that use SVG/canvas
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="responsive-container">{children}</div>,
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

const mockRepos = { repos: ['repo-a', 'repo-b'] };
const mockMetricsSummary = {
  'repo-a': {
    repo: 'repo-a',
    moduleCount: 10,
    avgInstability: 0.5,
    avgAbstractness: 0.3,
    avgDistance: 0.2,
    painZoneCount: 2,
    uselessnessZoneCount: 1,
  },
  'repo-b': {
    repo: 'repo-b',
    moduleCount: 5,
    avgInstability: 0.7,
    avgAbstractness: 0.1,
    avgDistance: 0.4,
    painZoneCount: 0,
    uselessnessZoneCount: 0,
  },
};
const mockPractices = {
  executive: {
    grade: 'B',
    score: 72,
    headline: 'Moderate technical debt',
  },
  scorecard: [
    { category: 'architecture', errorCount: 3, warningCount: 5, noteCount: 10 },
  ],
  atdi: {
    score: 72,
    trend: 'stable' as const,
    newFindingCount: 4,
    totalFindingCount: 18,
    categoryBreakdown: [],
  },
};
const mockHotspots: unknown[] = [];
const mockAllMetrics: unknown[] = [];
const mockAtdi = {
  score: 72,
  repoScores: [{ repo: 'repo-a', score: 70 }],
  computedAt: '2026-01-01',
};

function setupFetchMock() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/repos')) return jsonResponse(mockRepos);
    if (url.includes('/api/metrics-summary')) return jsonResponse(mockMetricsSummary);
    if (url.includes('/api/practices')) return jsonResponse(mockPractices);
    if (url.includes('/api/hotspots')) return jsonResponse(mockHotspots);
    if (url.includes('/api/metrics-all')) return jsonResponse(mockAllMetrics);
    if (url.includes('/api/atdi')) return jsonResponse(mockAtdi);
    return jsonResponse({});
  }));
}

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  setupFetchMock();
});

describe('Overview', () => {
  it('renders loading state initially', () => {
    const { container } = render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders repo cards after data loads', async () => {
    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    expect(await screen.findByText('repo-a')).toBeInTheDocument();
    expect(screen.getByText('repo-b')).toBeInTheDocument();
  });

  it('renders ATDI score section', async () => {
    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Technical Debt Index')).toBeInTheDocument();
    expect(screen.getByText('stable')).toBeInTheDocument();
    expect(screen.getByText(/4 new \/ 18 total findings/)).toBeInTheDocument();
  });

  it('renders Repositories heading', async () => {
    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Repositories')).toBeInTheDocument();
  });

  it('shows zone badges on repo cards', async () => {
    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    expect(await screen.findByText('2 pain zone')).toBeInTheDocument();
    expect(screen.getByText('1 useless zone')).toBeInTheDocument();
    expect(screen.getByText('10 modules')).toBeInTheDocument();
  });
});
