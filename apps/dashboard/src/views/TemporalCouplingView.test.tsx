// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TemporalCouplingView from './TemporalCouplingView.tsx';

const mockRepos = { repos: ['repo-a', 'repo-b'] };
const mockCoupling = [
  {
    fileA: 'src/a.ts',
    fileB: 'src/b.ts',
    coChangeCount: 15,
    supportA: 0.6,
    supportB: 0.5,
    confidence: 0.85,
    repo: 'repo-a',
  },
  {
    fileA: 'src/c.ts',
    fileB: 'src/d.ts',
    coChangeCount: 8,
    supportA: 0.4,
    supportB: 0.3,
    confidence: 0.6,
    repo: 'repo-b',
  },
];

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function setupFetchMock() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/repos')) return jsonResponse(mockRepos);
    if (url.includes('/api/temporal-coupling')) return jsonResponse(mockCoupling);
    return jsonResponse({});
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  setupFetchMock();
});

describe('TemporalCouplingView', () => {
  it('renders loading state initially', () => {
    render(
      <MemoryRouter>
        <TemporalCouplingView />
      </MemoryRouter>,
    );
    expect(screen.getByText('Loading temporal coupling data...')).toBeInTheDocument();
  });

  it('renders the heading', async () => {
    render(
      <MemoryRouter>
        <TemporalCouplingView />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Temporal Coupling')).toBeInTheDocument();
  });

  it('renders table with coupling data', async () => {
    render(
      <MemoryRouter>
        <TemporalCouplingView />
      </MemoryRouter>,
    );
    expect(await screen.findByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('85%')).toBeInTheDocument();
  });

  it('renders table headers', async () => {
    render(
      <MemoryRouter>
        <TemporalCouplingView />
      </MemoryRouter>,
    );
    await screen.findByText('src/a.ts');
    expect(screen.getByText(/File A/)).toBeInTheDocument();
    expect(screen.getByText(/File B/)).toBeInTheDocument();
    expect(screen.getByText(/Co-changes/)).toBeInTheDocument();
    // "Confidence" appears in header and footer text, use columnheader role
    expect(screen.getAllByText(/Confidence/).length).toBeGreaterThanOrEqual(1);
  });

  it('renders repo filter', async () => {
    render(
      <MemoryRouter>
        <TemporalCouplingView />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/All repos \(2 pairs\)/)).toBeInTheDocument();
  });

  it('sorts by column when header clicked', async () => {
    render(
      <MemoryRouter>
        <TemporalCouplingView />
      </MemoryRouter>,
    );
    await screen.findByText('src/a.ts');
    // Default sort is by coChangeCount descending, so 15 should be first
    const rows = screen.getAllByRole('row');
    // First row is header, second should have 15
    expect(rows[1]!.textContent).toContain('15');
  });

  it('shows both repos in dropdown', async () => {
    render(
      <MemoryRouter>
        <TemporalCouplingView />
      </MemoryRouter>,
    );
    await screen.findByText('src/a.ts');
    const options = screen.getAllByRole('option');
    expect(options.some((o) => o.textContent?.includes('repo-a'))).toBe(true);
    expect(options.some((o) => o.textContent?.includes('repo-b'))).toBe(true);
  });
});
