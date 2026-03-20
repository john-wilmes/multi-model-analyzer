import React from 'react';

const FolderIcon = (): React.ReactElement => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-12 w-12"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.5}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
    />
  </svg>
);

const SearchIcon = (): React.ReactElement => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-12 w-12"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.5}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z"
    />
  </svg>
);

const ChartIcon = (): React.ReactElement => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-12 w-12"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.5}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
    />
  </svg>
);

const ICON_MAP: Record<string, () => React.ReactElement> = {
  folder: FolderIcon,
  search: SearchIcon,
  chart: ChartIcon,
};

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({
  icon = 'folder',
  title,
  description,
  action,
}: EmptyStateProps): React.ReactElement {
  const IconComponent = ICON_MAP[icon] ?? FolderIcon;

  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <div className="text-slate-400 dark:text-slate-500 mb-4">
        <IconComponent />
      </div>
      <p className="text-lg font-medium text-slate-600 dark:text-slate-300 mb-1">{title}</p>
      {description && (
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
