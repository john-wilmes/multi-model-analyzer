import React from 'react';

const GRADE_COLORS: Record<string, string> = {
  A: 'text-green-600 dark:text-green-400',
  B: 'text-lime-600 dark:text-lime-400',
  C: 'text-yellow-600 dark:text-yellow-400',
  D: 'text-orange-500 dark:text-orange-400',
  F: 'text-red-600 dark:text-red-400',
};

const GRADE_BG_COLORS: Record<string, string> = {
  A: 'border-green-600 dark:border-green-400',
  B: 'border-lime-600 dark:border-lime-400',
  C: 'border-yellow-600 dark:border-yellow-400',
  D: 'border-orange-500 dark:border-orange-400',
  F: 'border-red-600 dark:border-red-400',
};

interface GradeBadgeProps {
  grade: string;
  size?: 'sm' | 'lg';
}

export function GradeBadge({ grade, size = 'sm' }: GradeBadgeProps): React.ReactElement {
  const letter = grade.charAt(0).toUpperCase();
  const colorClass = GRADE_COLORS[letter] ?? 'text-slate-600 dark:text-slate-400';
  const borderClass = GRADE_BG_COLORS[letter] ?? 'border-slate-400 dark:border-slate-500';

  if (size === 'lg') {
    return (
      <div
        className={`h-16 w-16 rounded-full border-4 flex items-center justify-center ${borderClass}`}
      >
        <span className={`text-3xl font-bold ${colorClass}`}>{letter}</span>
      </div>
    );
  }

  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium border ${borderClass} ${colorClass}`}
    >
      {grade}
    </span>
  );
}
