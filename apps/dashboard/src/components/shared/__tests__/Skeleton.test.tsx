import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton, SkeletonCard } from '../Skeleton.tsx';

describe('Skeleton', () => {
  it('renders text variant with correct height and width classes', () => {
    const { container } = render(<Skeleton variant="text" />);
    const el = container.querySelector('div');
    expect(el?.className).toContain('h-4');
    expect(el?.className).toContain('w-full');
    expect(el?.className).toContain('rounded');
  });

  it('renders circle variant with rounded-full', () => {
    const { container } = render(<Skeleton variant="circle" />);
    const el = container.querySelector('div');
    expect(el?.className).toContain('rounded-full');
    expect(el?.className).toContain('h-12');
    expect(el?.className).toContain('w-12');
  });

  it('renders rect variant with correct classes', () => {
    const { container } = render(<Skeleton variant="rect" />);
    const el = container.querySelector('div');
    expect(el?.className).toContain('h-32');
    expect(el?.className).toContain('w-full');
    expect(el?.className).toContain('rounded-lg');
  });

  it('renders chart variant with correct classes', () => {
    const { container } = render(<Skeleton variant="chart" />);
    const el = container.querySelector('div');
    expect(el?.className).toContain('h-64');
    expect(el?.className).toContain('w-full');
    expect(el?.className).toContain('rounded-lg');
  });

  it('all variants have animate-pulse class', () => {
    for (const variant of ['text', 'circle', 'rect', 'chart'] as const) {
      const { container } = render(<Skeleton variant={variant} />);
      const el = container.querySelector('div');
      expect(el?.className).toContain('animate-pulse');
    }
  });

  it('defaults to text variant when no variant prop given', () => {
    const { container } = render(<Skeleton />);
    const el = container.querySelector('div');
    expect(el?.className).toContain('h-4');
    expect(el?.className).toContain('animate-pulse');
  });

  it('applies extra className from prop', () => {
    const { container } = render(<Skeleton className="mb-3 w-1/3" />);
    const el = container.querySelector('div');
    expect(el?.className).toContain('mb-3');
    expect(el?.className).toContain('w-1/3');
  });
});

describe('SkeletonCard', () => {
  it('renders card structure', () => {
    const { container } = render(<SkeletonCard />);
    const card = container.firstChild as HTMLElement;
    expect(card).toBeInTheDocument();
    expect(card.className).toContain('rounded-lg');
    expect(card.className).toContain('shadow-sm');
  });

  it('renders multiple skeleton rows inside the card', () => {
    const { container } = render(<SkeletonCard />);
    // SkeletonCard renders 4 Skeleton children (1 title + 3 body rows)
    const skeletons = container.querySelectorAll('[class*="animate-pulse"]');
    expect(skeletons.length).toBe(4);
  });

  it('all skeletons inside card have animate-pulse', () => {
    const { container } = render(<SkeletonCard />);
    const skeletons = container.querySelectorAll('[class*="animate-pulse"]');
    skeletons.forEach((el) => {
      expect(el.className).toContain('animate-pulse');
    });
  });
});
