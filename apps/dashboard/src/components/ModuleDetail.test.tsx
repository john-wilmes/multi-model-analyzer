// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ModuleDetail from './ModuleDetail.tsx';

const mockFindings = {
  results: [
    {
      ruleId: 'MMA005',
      level: 'warning',
      message: 'Circular dependency detected',
      locations: [
        {
          logicalLocations: [
            { fullyQualifiedName: 'src/utils/helper.ts' },
          ],
        },
      ],
    },
  ],
  total: 1,
};

const mockDependencies = {
  dependencies: [
    { path: 'src/lib/core.ts', depth: 1 },
    { path: 'src/lib/config.ts', depth: 1 },
  ],
  dependents: [
    { path: 'src/app.ts', depth: 1 },
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
    if (url.includes('/api/findings')) return jsonResponse(mockFindings);
    if (url.includes('/api/dependencies/')) return jsonResponse(mockDependencies);
    return jsonResponse({});
  }));
}

function renderWithRoute() {
  return render(
    <MemoryRouter initialEntries={['/repo/my-repo/module/src/utils/helper.ts']}>
      <Routes>
        <Route path="/repo/:name/module/*" element={<ModuleDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  setupFetchMock();
});

describe('ModuleDetail', () => {
  it('renders loading state initially', () => {
    renderWithRoute();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders module path as heading', async () => {
    renderWithRoute();
    expect(await screen.findByText('src/utils/helper.ts')).toBeInTheDocument();
  });

  it('renders metrics card', async () => {
    renderWithRoute();
    expect(await screen.findByText('Metrics')).toBeInTheDocument();
    expect(screen.getByText('Instability')).toBeInTheDocument();
    expect(screen.getByText('Afferent (Ca)')).toBeInTheDocument();
    expect(screen.getByText('Efferent (Ce)')).toBeInTheDocument();
    expect(screen.getByText('Distance')).toBeInTheDocument();
  });

  it('renders correct coupling values', async () => {
    renderWithRoute();
    // 2 outgoing deps, 1 incoming dep
    await screen.findByText('Metrics');
    expect(screen.getByText('1')).toBeInTheDocument(); // Ca
    expect(screen.getByText('2')).toBeInTheDocument(); // Ce
  });

  it('renders findings section', async () => {
    renderWithRoute();
    expect(await screen.findByText('Findings')).toBeInTheDocument();
    expect(screen.getByText('MMA005')).toBeInTheDocument();
    expect(screen.getByText('Circular dependency detected')).toBeInTheDocument();
  });

  it('renders dependency lists', async () => {
    renderWithRoute();
    expect(await screen.findByText('Depends on (2)')).toBeInTheDocument();
    expect(screen.getByText('Depended on by (1)')).toBeInTheDocument();
    expect(screen.getByText('src/lib/core.ts')).toBeInTheDocument();
    expect(screen.getByText('src/lib/config.ts')).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
  });

  it('renders back link to repo', async () => {
    renderWithRoute();
    const link = await screen.findByText(/my-repo/);
    expect(link).toBeInTheDocument();
  });
});
