import React from 'react';

const SEVERITY_COLORS: Record<string, string> = {
  error: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  warning: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  note: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  recommendation: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
};

interface SeverityBadgeProps {
  severity?: string;
}

export function SeverityBadge({ severity = 'note' }: SeverityBadgeProps): React.ReactElement {
  const colorClass =
    SEVERITY_COLORS[severity.toLowerCase()] ??
    'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300';

  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colorClass}`}>
      {severity}
    </span>
  );
}
