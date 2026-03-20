// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FindingsTable from './FindingsTable.tsx';

const mockRepos = { repos: ['repo-a', 'repo-b'] };
const mockFindings = {
  results: [
    {
      ruleId: 'MMA001',
      level: 'error',
      message: 'High instability module',
      locations: [{ logicalLocations: [{ fullyQualifiedName: 'src/index.ts' }] }],
    },
    {
      ruleId: 'MMA002',
      level: 'warning',
      message: 'Unused export detected',
      locations: [{ logicalLocations: [{ fullyQualifiedName: 'src/utils.ts' }] }],
    },
    {
      ruleId: 'MMA003',
      level: 'note',
      message: 'Consider refactoring',
      locations: [{ logicalLocations: [{ fullyQualifiedName: 'src/helper.ts' }] }],
    },
  ],
  total: 3,
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
    if (url.includes('/api/findings')) return jsonResponse(mockFindings);
    return jsonResponse({});
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  setupFetchMock();
});

describe('FindingsTable', () => {
  it('renders the Findings heading', async () => {
    render(
      <MemoryRouter>
        <FindingsTable />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Findings')).toBeInTheDocument();
  });

  it('renders table rows with finding data', async () => {
    render(
      <MemoryRouter>
        <FindingsTable />
      </MemoryRouter>,
    );
    expect(await screen.findByText('MMA001')).toBeInTheDocument();
    expect(screen.getByText('MMA002')).toBeInTheDocument();
    expect(screen.getByText('MMA003')).toBeInTheDocument();
    expect(screen.getByText('High instability module')).toBeInTheDocument();
  });

  it('renders pagination controls', async () => {
    render(
      <MemoryRouter>
        <FindingsTable />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Prev')).toBeInTheDocument();
    expect(screen.getByText('Next')).toBeInTheDocument();
    expect(screen.getByText(/1–3 of 3/)).toBeInTheDocument();
  });

  it('renders repo filter dropdown', async () => {
    render(
      <MemoryRouter>
        <FindingsTable />
      </MemoryRouter>,
    );
    expect(await screen.findByText('All repos')).toBeInTheDocument();
    // The label "Repo" exists as a text element above the select
    expect(screen.getByText('Repo')).toBeInTheDocument();
  });

  it('renders severity checkboxes', async () => {
    render(
      <MemoryRouter>
        <FindingsTable />
      </MemoryRouter>,
    );
    await screen.findByText('MMA001');
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);
  });

  it('renders rule ID filter input', async () => {
    render(
      <MemoryRouter>
        <FindingsTable />
      </MemoryRouter>,
    );
    expect(await screen.findByPlaceholderText('e.g. MMA001')).toBeInTheDocument();
  });

  it('shows table headers', async () => {
    render(
      <MemoryRouter>
        <FindingsTable />
      </MemoryRouter>,
    );
    await screen.findByText('MMA001');
    // "Severity" and "Rule ID" appear in both filter section and table header
    expect(screen.getAllByText('Severity').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Rule ID').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Message')).toBeInTheDocument();
    expect(screen.getByText('Location')).toBeInTheDocument();
  });
});
