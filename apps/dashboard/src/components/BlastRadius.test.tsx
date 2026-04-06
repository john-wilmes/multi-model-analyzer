// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import BlastRadius from './BlastRadius.tsx';

// Mock cytoscape to avoid canvas issues in jsdom
vi.mock('cytoscape', () => ({
  default: vi.fn(() => ({
    on: vi.fn(),
    destroy: vi.fn(),
    elements: vi.fn(() => ({ addClass: vi.fn(), removeClass: vi.fn() })),
    nodes: vi.fn(() => ({ filter: vi.fn(() => ({ removeClass: vi.fn() })) })),
  })),
}));

const mockRepos = { repos: ['repo-a', 'repo-b'] };
const mockOverview = {
  repo: 'repo-a',
  files: [
    { path: 'src/core/index.ts', score: 0.045, rank: 1, reachCount: 25 },
    { path: 'src/utils/helper.ts', score: 0.032, rank: 2, reachCount: 15 },
  ],
  totalNodes: 50,
};

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function setupFetchMock() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/repos')) return jsonResponse(mockRepos);
    if (url.includes('/api/blast-radius/')) return jsonResponse(mockOverview);
    return jsonResponse({});
  }));
}

function renderWithRoute(entry = '/blast-radius/repo-a') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/blast-radius/:name" element={<BlastRadius />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  setupFetchMock();
});

describe('BlastRadius', () => {
  it('renders the Blast Radius heading', async () => {
    renderWithRoute();
    expect(await screen.findByText('Blast Radius')).toBeInTheDocument();
  });

  it('renders the file list after data loads', async () => {
    renderWithRoute();
    expect(await screen.findByText('index.ts')).toBeInTheDocument();
    expect(screen.getByText('helper.ts')).toBeInTheDocument();
  });

  it('shows total node count', async () => {
    renderWithRoute();
    expect(await screen.findByText('(50 total)')).toBeInTheDocument();
  });

  it('shows High-Risk Files heading', async () => {
    renderWithRoute();
    expect(await screen.findByText('High-Risk Files')).toBeInTheDocument();
  });

  it('shows file paths', async () => {
    renderWithRoute();
    expect(await screen.findByText('src/core/index.ts')).toBeInTheDocument();
    expect(screen.getByText('src/utils/helper.ts')).toBeInTheDocument();
  });

  it('shows PageRank scores', async () => {
    renderWithRoute();
    expect(await screen.findByText('PR: 0.0450')).toBeInTheDocument();
    expect(screen.getByText('PR: 0.0320')).toBeInTheDocument();
  });

  it('shows reach counts', async () => {
    renderWithRoute();
    expect(await screen.findByText('Reach: 25')).toBeInTheDocument();
    expect(screen.getByText('Reach: 15')).toBeInTheDocument();
  });

  it('shows placeholder when no file selected', async () => {
    renderWithRoute();
    expect(
      await screen.findByText('Select a file from the list to view its blast radius graph'),
    ).toBeInTheDocument();
  });

  it('renders repo selector', async () => {
    renderWithRoute();
    await screen.findByText('index.ts');
    const options = screen.getAllByRole('option');
    expect(options.some((o) => o.textContent === 'repo-a')).toBe(true);
    expect(options.some((o) => o.textContent === 'repo-b')).toBe(true);
  });
});
