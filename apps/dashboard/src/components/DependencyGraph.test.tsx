// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DependencyGraph from './DependencyGraph.tsx';

// Mock cytoscape and cytoscape-dagre
vi.mock('cytoscape', () => {
  const mockCy = vi.fn(() => ({
    on: vi.fn(),
    destroy: vi.fn(),
    elements: vi.fn(() => ({ addClass: vi.fn(), removeClass: vi.fn() })),
    nodes: vi.fn(() => ({ filter: vi.fn(() => ({ removeClass: vi.fn() })) })),
  }));
  return { default: mockCy };
});

vi.mock('cytoscape-dagre', () => ({
  default: vi.fn(),
}));

const mockEdges = {
  edges: [
    { source: 'src/a.ts', target: 'src/b.ts', kind: 'imports' },
    { source: 'src/b.ts', target: 'src/c.ts', kind: 'imports' },
  ],
};

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function setupFetchMock() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/graph/')) return jsonResponse(mockEdges);
    return jsonResponse({});
  }));
}

function renderWithRoute() {
  return render(
    <MemoryRouter initialEntries={['/graph/my-repo']}>
      <Routes>
        <Route path="/graph/:name" element={<DependencyGraph />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  setupFetchMock();
});

describe('DependencyGraph', () => {
  it('renders loading state initially', () => {
    renderWithRoute();
    expect(screen.getByText('Loading dependency graph...')).toBeInTheDocument();
  });

  it('renders the heading with repo name', async () => {
    renderWithRoute();
    expect(await screen.findByText(/Dependency Graph — my-repo/)).toBeInTheDocument();
  });

  it('renders node and edge counts', async () => {
    renderWithRoute();
    expect(await screen.findByText(/3 nodes · 2 edges/)).toBeInTheDocument();
  });

  it('renders edge kind selector', async () => {
    renderWithRoute();
    await screen.findByText(/Dependency Graph/);
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options.some((o) => o.textContent === 'imports')).toBe(true);
    expect(options.some((o) => o.textContent === 'calls')).toBe(true);
  });

  it('renders without crashing when edges are empty', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      jsonResponse({ edges: [] }),
    ));
    renderWithRoute();
    expect(await screen.findByText(/No imports edges found/)).toBeInTheDocument();
  });

  it('shows error state on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: false, status: 500, statusText: 'Internal Server Error' }),
    ));
    renderWithRoute();
    expect(await screen.findByText(/API error: 500/)).toBeInTheDocument();
  });
});
