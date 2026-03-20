import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockFindings = {
  results: [
    {
      ruleId: 'rule-1',
      message: { text: 'Issue A' },
      level: 'error',
      locations: [
        {
          logicalLocations: [{ fullyQualifiedName: 'repo-a|src/a.ts' }],
        },
      ],
    },
    {
      ruleId: 'rule-1',
      message: { text: 'Issue B' },
      level: 'error',
      locations: [
        {
          logicalLocations: [{ fullyQualifiedName: 'repo-a|src/b.ts' }],
        },
      ],
    },
    {
      ruleId: 'rule-2',
      message: { text: 'Issue C' },
      level: 'warning',
      locations: [
        {
          logicalLocations: [{ fullyQualifiedName: 'repo-b|src/c.ts' }],
        },
      ],
    },
  ],
  total: 3,
};

vi.mock('../../api/client.ts', () => ({
  fetchRepos: vi.fn(() => Promise.resolve({ repos: ['repo-a', 'repo-b'] })),
  fetchFindings: vi.fn(() => Promise.resolve(mockFindings)),
}));

import FindingsTable from '../FindingsTable.tsx';

function renderFindings(path = '/findings') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <FindingsTable />
    </MemoryRouter>
  );
}

describe('FindingsTable', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders findings table heading', async () => {
    renderFindings();
    await waitFor(() => {
      expect(screen.getByText('Findings')).toBeInTheDocument();
    });
  });

  it('shows all findings as rows in flat mode by default', async () => {
    renderFindings();
    await waitFor(() => {
      expect(screen.getByText('Issue A')).toBeInTheDocument();
      expect(screen.getByText('Issue B')).toBeInTheDocument();
      expect(screen.getByText('Issue C')).toBeInTheDocument();
    });
  });

  it('renders Flat and By Rule toggle buttons', async () => {
    renderFindings();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Flat' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'By Rule' })).toBeInTheDocument();
    });
  });

  it('can switch to group-by-rule mode via toggle', async () => {
    renderFindings();
    await waitFor(() => {
      expect(screen.getByText('Issue A')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'By Rule' }));

    // In by-rule mode, rule IDs are shown as section headers
    await waitFor(() => {
      expect(screen.getByText('rule-1')).toBeInTheDocument();
      expect(screen.getByText('rule-2')).toBeInTheDocument();
    });
  });

  it('in group-by-rule mode, shows rule sections with count badges', async () => {
    renderFindings();
    await waitFor(() => {
      expect(screen.getByText('Issue A')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'By Rule' }));

    await waitFor(() => {
      // rule-1 has 2 findings, rule-2 has 1
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('1')).toBeInTheDocument();
    });
  });

  it('in group-by-rule mode, clicking a rule section expands it', async () => {
    renderFindings();
    await waitFor(() => {
      expect(screen.getByText('Issue A')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'By Rule' }));

    await waitFor(() => {
      expect(screen.getByText('rule-1')).toBeInTheDocument();
    });

    // Initially, findings are not shown in the accordion
    expect(screen.queryByText('Issue A')).not.toBeInTheDocument();

    // Click on the rule-1 section button
    const rule1Button = screen.getByText('rule-1').closest('button');
    expect(rule1Button).toBeInTheDocument();
    fireEvent.click(rule1Button!);

    await waitFor(() => {
      expect(screen.getByText('Issue A')).toBeInTheDocument();
      expect(screen.getByText('Issue B')).toBeInTheDocument();
    });
  });

  it('in flat mode, clicking a row expands detail panel', async () => {
    renderFindings();
    await waitFor(() => {
      expect(screen.getByText('Issue A')).toBeInTheDocument();
    });

    // The flat table rows are clickable
    const rows = document.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThan(0);

    // Click first row
    fireEvent.click(rows[0]);

    // Detail panel appears: "Severity" label appears in header (1) and detail panel (1+) = 2+
    await waitFor(() => {
      expect(screen.getAllByText('Severity').length).toBeGreaterThan(1);
    });
  });

  it('clicking an expanded row again collapses it', async () => {
    renderFindings();
    await waitFor(() => {
      expect(screen.getByText('Issue A')).toBeInTheDocument();
    });

    // Count "Severity" occurrences before expand — just the table header column
    const beforeCount = screen.getAllByText('Severity').length;

    const rows = document.querySelectorAll('tbody tr');
    // Click to expand — more "Severity" labels appear in the detail panel
    fireEvent.click(rows[0]);
    await waitFor(() => {
      expect(screen.getAllByText('Severity').length).toBeGreaterThan(beforeCount);
    });

    // Click the first data row again to collapse
    const firstDataRow = document.querySelector('tbody tr');
    fireEvent.click(firstDataRow!);
    await waitFor(() => {
      expect(screen.getAllByText('Severity').length).toBe(beforeCount);
    });
  });

  it('shows severity badges with correct styling', async () => {
    renderFindings();
    await waitFor(() => {
      expect(screen.getByText('Issue A')).toBeInTheDocument();
    });

    // There should be severity badges for 'error' (×2) and 'warning' (×1)
    const errorBadges = screen.getAllByText('error');
    const warningBadges = screen.getAllByText('warning');
    expect(errorBadges.length).toBeGreaterThanOrEqual(2);
    expect(warningBadges.length).toBeGreaterThanOrEqual(1);
  });
});
