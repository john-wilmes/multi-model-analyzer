import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeverityBadge } from '../SeverityBadge.tsx';

describe('SeverityBadge', () => {
  it('renders correct text for error severity', () => {
    render(<SeverityBadge severity="error" />);
    expect(screen.getByText('error')).toBeInTheDocument();
  });

  it('renders correct text for warning severity', () => {
    render(<SeverityBadge severity="warning" />);
    expect(screen.getByText('warning')).toBeInTheDocument();
  });

  it('renders correct text for note severity', () => {
    render(<SeverityBadge severity="note" />);
    expect(screen.getByText('note')).toBeInTheDocument();
  });

  it('renders correct text for recommendation severity', () => {
    render(<SeverityBadge severity="recommendation" />);
    expect(screen.getByText('recommendation')).toBeInTheDocument();
  });

  it('applies red color classes for error severity', () => {
    const { container } = render(<SeverityBadge severity="error" />);
    const span = container.querySelector('span');
    expect(span?.className).toContain('bg-red-100');
    expect(span?.className).toContain('text-red-800');
  });

  it('applies yellow color classes for warning severity', () => {
    const { container } = render(<SeverityBadge severity="warning" />);
    const span = container.querySelector('span');
    expect(span?.className).toContain('bg-yellow-100');
    expect(span?.className).toContain('text-yellow-800');
  });

  it('applies blue color classes for note severity', () => {
    const { container } = render(<SeverityBadge severity="note" />);
    const span = container.querySelector('span');
    expect(span?.className).toContain('bg-blue-100');
    expect(span?.className).toContain('text-blue-700');
  });

  it('applies green color classes for recommendation severity', () => {
    const { container } = render(<SeverityBadge severity="recommendation" />);
    const span = container.querySelector('span');
    expect(span?.className).toContain('bg-green-100');
    expect(span?.className).toContain('text-green-800');
  });

  it('falls back to slate for unknown severity', () => {
    const { container } = render(<SeverityBadge severity="unknown-level" />);
    const span = container.querySelector('span');
    expect(span?.className).toContain('bg-slate-100');
    expect(span?.className).toContain('text-slate-700');
  });

  it('renders with default severity (note) when prop is undefined', () => {
    render(<SeverityBadge />);
    expect(screen.getByText('note')).toBeInTheDocument();
  });

  it('renders with default severity (note) when prop is empty string', () => {
    // Empty string lowercased is '', which won't match any key, falls back to slate
    const { container } = render(<SeverityBadge severity="" />);
    const span = container.querySelector('span');
    // Empty string: SEVERITY_COLORS[''] is undefined, falls back to slate
    expect(span?.className).toContain('bg-slate-100');
  });
});
