import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GradeBadge } from '../GradeBadge.tsx';

describe('GradeBadge', () => {
  it('renders correct grade letter for A', () => {
    render(<GradeBadge grade="A" />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('renders correct grade letter for B', () => {
    render(<GradeBadge grade="B" />);
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('renders correct grade letter for C', () => {
    render(<GradeBadge grade="C" />);
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('renders correct grade letter for D', () => {
    render(<GradeBadge grade="D" />);
    expect(screen.getByText('D')).toBeInTheDocument();
  });

  it('renders correct grade letter for F', () => {
    render(<GradeBadge grade="F" />);
    expect(screen.getByText('F')).toBeInTheDocument();
  });

  it('applies green color for grade A', () => {
    const { container } = render(<GradeBadge grade="A" />);
    expect(container.querySelector('[class*="text-green-"]')).toBeInTheDocument();
    expect(container.querySelector('[class*="border-green-"]')).toBeInTheDocument();
  });

  it('applies lime color for grade B', () => {
    const { container } = render(<GradeBadge grade="B" />);
    expect(container.querySelector('[class*="text-lime-"]')).toBeInTheDocument();
    expect(container.querySelector('[class*="border-lime-"]')).toBeInTheDocument();
  });

  it('applies yellow color for grade C', () => {
    const { container } = render(<GradeBadge grade="C" />);
    expect(container.querySelector('[class*="text-yellow-"]')).toBeInTheDocument();
    expect(container.querySelector('[class*="border-yellow-"]')).toBeInTheDocument();
  });

  it('applies orange color for grade D', () => {
    const { container } = render(<GradeBadge grade="D" />);
    expect(container.querySelector('[class*="text-orange-"]')).toBeInTheDocument();
    expect(container.querySelector('[class*="border-orange-"]')).toBeInTheDocument();
  });

  it('applies red color for grade F', () => {
    const { container } = render(<GradeBadge grade="F" />);
    expect(container.querySelector('[class*="text-red-"]')).toBeInTheDocument();
    expect(container.querySelector('[class*="border-red-"]')).toBeInTheDocument();
  });

  it('renders small (span) variant by default', () => {
    const { container } = render(<GradeBadge grade="A" />);
    // Default size is 'sm' which renders a <span>
    expect(container.querySelector('span')).toBeInTheDocument();
    expect(container.querySelector('div')).not.toBeInTheDocument();
  });

  it('renders small (pill) variant when size is sm', () => {
    const { container } = render(<GradeBadge grade="B" size="sm" />);
    expect(container.querySelector('span')).toBeInTheDocument();
    expect(container.querySelector('div')).not.toBeInTheDocument();
  });

  it('renders large (circle) variant when size is lg', () => {
    const { container } = render(<GradeBadge grade="A" size="lg" />);
    // Large variant renders a div with rounded-full
    const div = container.querySelector('div');
    expect(div).toBeInTheDocument();
    expect(div?.className).toContain('rounded-full');
    expect(div?.className).toContain('h-16');
    expect(div?.className).toContain('w-16');
  });

  it('renders large variant with grade letter in span inside div', () => {
    render(<GradeBadge grade="A" size="lg" />);
    // The letter is shown inside the circle
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('falls back to slate for unknown grade', () => {
    const { container } = render(<GradeBadge grade="Z" />);
    expect(container.querySelector('[class*="text-slate-"]')).toBeInTheDocument();
  });
});
