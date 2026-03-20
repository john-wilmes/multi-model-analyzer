// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CrossRepoView from './CrossRepoView.tsx';

// Mock the sub-components to avoid deep rendering
vi.mock('./CrossRepoGraphView.tsx', () => ({
  default: () => <div data-testid="cross-repo-graph">CrossRepoGraphView</div>,
}));
vi.mock('./FeatureFlagsTable.tsx', () => ({
  default: ({ repo }: { repo?: string }) => <div data-testid="feature-flags-table">FeatureFlagsTable {repo}</div>,
}));
vi.mock('./CascadingFaultsTable.tsx', () => ({
  default: ({ repo }: { repo?: string }) => <div data-testid="cascading-faults-table">CascadingFaultsTable {repo}</div>,
}));
vi.mock('./ServiceCatalogTable.tsx', () => ({
  default: ({ repo }: { repo?: string }) => <div data-testid="service-catalog-table">ServiceCatalogTable {repo}</div>,
}));

const mockRepos = { repos: ['repo-a', 'repo-b'] };

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function setupFetchMock() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/repos')) return jsonResponse(mockRepos);
    return jsonResponse({});
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  setupFetchMock();
});

describe('CrossRepoView', () => {
  it('renders all tab buttons', () => {
    render(
      <MemoryRouter>
        <CrossRepoView />
      </MemoryRouter>,
    );
    expect(screen.getByText('Graph')).toBeInTheDocument();
    expect(screen.getByText('Feature Flags')).toBeInTheDocument();
    expect(screen.getByText('Cascading Faults')).toBeInTheDocument();
    expect(screen.getByText('Service Catalog')).toBeInTheDocument();
  });

  it('shows Graph tab content by default', () => {
    render(
      <MemoryRouter>
        <CrossRepoView />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('cross-repo-graph')).toBeInTheDocument();
  });

  it('switches to Feature Flags tab on click', () => {
    render(
      <MemoryRouter>
        <CrossRepoView />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Feature Flags'));
    expect(screen.getByTestId('feature-flags-table')).toBeInTheDocument();
    expect(screen.queryByTestId('cross-repo-graph')).not.toBeInTheDocument();
  });

  it('switches to Cascading Faults tab on click', () => {
    render(
      <MemoryRouter>
        <CrossRepoView />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Cascading Faults'));
    expect(screen.getByTestId('cascading-faults-table')).toBeInTheDocument();
  });

  it('switches to Service Catalog tab on click', () => {
    render(
      <MemoryRouter>
        <CrossRepoView />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Service Catalog'));
    expect(screen.getByTestId('service-catalog-table')).toBeInTheDocument();
  });

  it('renders repo filter dropdown', async () => {
    render(
      <MemoryRouter>
        <CrossRepoView />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('Filter by repo')).toBeInTheDocument();
    expect(await screen.findByText('All repos')).toBeInTheDocument();
  });
});
