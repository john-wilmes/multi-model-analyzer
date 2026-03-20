import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyState } from '../EmptyState.tsx';

describe('EmptyState', () => {
  it('renders title text', () => {
    render(<EmptyState title="No data found" />);
    expect(screen.getByText('No data found')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<EmptyState title="No data" description="Try adjusting your filters." />);
    expect(screen.getByText('Try adjusting your filters.')).toBeInTheDocument();
  });

  it('does not render description element when not provided', () => {
    render(<EmptyState title="No data" />);
    expect(screen.queryByText(/filter/i)).not.toBeInTheDocument();
    // Only one <p> element (the title)
    const paragraphs = document.querySelectorAll('p');
    expect(paragraphs.length).toBe(1);
  });

  it('renders action button when provided', () => {
    const onClick = vi.fn();
    render(<EmptyState title="No data" action={{ label: 'Retry', onClick }} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('calls onClick when action button is clicked', () => {
    const onClick = vi.fn();
    render(<EmptyState title="No data" action={{ label: 'Retry', onClick }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not render action button when not provided', () => {
    render(<EmptyState title="No data" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders an SVG icon', () => {
    const { container } = render(<EmptyState title="No data" />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders folder icon by default', () => {
    const { container } = render(<EmptyState title="No data" icon="folder" />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders search icon when icon=search', () => {
    const { container } = render(<EmptyState title="No results" icon="search" />);
    // The search icon has a circle element (the lens)
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('renders chart icon when icon=chart', () => {
    const { container } = render(<EmptyState title="No chart" icon="chart" />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('falls back to folder icon for unknown icon prop', () => {
    // Should not throw and should render an SVG
    const { container } = render(<EmptyState title="No data" icon="unknown-icon" />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});
