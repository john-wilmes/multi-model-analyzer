import React from 'react';

const SIZE_CLASSES: Record<NonNullable<SpinnerProps['size']>, string> = {
  sm: 'h-4 w-4',
  md: 'h-8 w-8',
  lg: 'h-12 w-12',
};

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function Spinner({ size = 'md', className = '' }: SpinnerProps): React.ReactElement {
  const sizeClass = SIZE_CLASSES[size];
  return (
    <div
      className={`border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin ${sizeClass} ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}
