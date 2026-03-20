import React from 'react';

const FitIcon = (): React.ReactElement => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-4 w-4"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5"
    />
  </svg>
);

const ZoomInIcon = (): React.ReactElement => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-4 w-4"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
  </svg>
);

const ZoomOutIcon = (): React.ReactElement => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-4 w-4"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" />
  </svg>
);

const ResetIcon = (): React.ReactElement => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-4 w-4"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
    />
  </svg>
);

interface GraphControlsProps {
  cyInstanceRef: React.RefObject<any>;
  onLayoutChange?: (layout: string) => void;
  layouts?: string[];
}

export function GraphControls({
  cyInstanceRef,
  onLayoutChange,
  layouts,
}: GraphControlsProps): React.ReactElement {
  const buttonClass =
    'p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 transition-colors';

  const handleFit = (): void => {
    const cy = cyInstanceRef.current;
    if (cy) cy.fit();
  };

  const handleZoomIn = (): void => {
    const cy = cyInstanceRef.current;
    if (cy) cy.zoom(cy.zoom() * 1.2);
  };

  const handleZoomOut = (): void => {
    const cy = cyInstanceRef.current;
    if (cy) cy.zoom(cy.zoom() / 1.2);
  };

  const handleReset = (): void => {
    const cy = cyInstanceRef.current;
    if (cy) cy.fit();
  };

  return (
    <div className="absolute bottom-4 right-4 bg-white dark:bg-slate-800 rounded-lg shadow-lg border dark:border-slate-700 p-1 flex flex-col gap-1">
      <button className={buttonClass} onClick={handleFit} title="Fit to screen">
        <FitIcon />
      </button>
      <button className={buttonClass} onClick={handleZoomIn} title="Zoom in">
        <ZoomInIcon />
      </button>
      <button className={buttonClass} onClick={handleZoomOut} title="Zoom out">
        <ZoomOutIcon />
      </button>
      <button className={buttonClass} onClick={handleReset} title="Reset view">
        <ResetIcon />
      </button>
      {layouts && layouts.length > 0 && onLayoutChange && (
        <>
          <div className="border-t dark:border-slate-700 my-0.5" />
          <select
            className="text-xs p-1 rounded bg-transparent text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer outline-none"
            onChange={(e) => onLayoutChange(e.target.value)}
            defaultValue=""
            title="Change layout"
          >
            <option value="" disabled>
              Layout
            </option>
            {layouts.map((layout) => (
              <option key={layout} value={layout}>
                {layout}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}
