import React from 'react';

interface SkeletonProps {
  className?: string;
  variant?: 'text' | 'circle' | 'rect' | 'chart';
}

const VARIANT_CLASSES: Record<NonNullable<SkeletonProps['variant']>, string> = {
  text: 'h-4 w-full rounded',
  circle: 'h-12 w-12 rounded-full',
  rect: 'h-32 w-full rounded-lg',
  chart: 'h-64 w-full rounded-lg',
};

export function Skeleton({ className = '', variant = 'text' }: SkeletonProps): React.ReactElement {
  const variantClass = VARIANT_CLASSES[variant];
  return (
    <div
      className={`bg-slate-200 dark:bg-slate-700 animate-pulse ${variantClass} ${className}`}
    />
  );
}

export function SkeletonCard(): React.ReactElement {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 p-4">
      <Skeleton variant="text" className="mb-3 w-1/3" />
      <Skeleton variant="text" className="mb-2" />
      <Skeleton variant="text" className="mb-2 w-5/6" />
      <Skeleton variant="text" className="w-4/6" />
    </div>
  );
}
