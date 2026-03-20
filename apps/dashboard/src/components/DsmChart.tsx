import { useState, useEffect } from 'react';
import type { DsmData } from '../api/client.ts';

function cellColor(value: number, maxVal: number, dark = false): string {
  if (value === 0) return dark ? '#1e293b' : '#f8fafc'; // slate-800 / slate-50
  const t = Math.min(value / maxVal, 1);
  if (dark) {
    // dark mode: slate-800 → blue gradient
    const r = Math.round(30 + t * 30);   // 30 → 60
    const g = Math.round(41 + t * 29);   // 41 → 70
    const b = Math.round(59 + t * 171);  // 59 → 230
    return `rgb(${r},${g},${b})`;
  }
  // light: white → blue gradient
  const r = Math.round(241 - t * 181);
  const g = Math.round(245 - t * 175);
  const b = Math.round(249 - t * 19);
  return `rgb(${r},${g},${b})`;
}

function shortLabel(path: string): string {
  const parts = path.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : path;
}

interface HoverState {
  row: number;
  col: number;
  x: number;
  y: number;
}

export default function DsmChart({ data }: { data: DsmData }) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const { modules, matrix } = data;
  const n = modules.length;
  if (n === 0) return null;

  const cellSize = Math.max(8, Math.min(16, Math.floor(800 / n)));
  const margin = { left: 120, top: 120 };
  const svgWidth = margin.left + n * cellSize;
  const svgHeight = margin.top + n * cellSize;

  let maxVal = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = matrix[r]?.[c] ?? 0;
      if (v > maxVal) maxVal = v;
    }
  }

  return (
    <div style={{ position: 'relative', overflowX: 'auto' }}>
      <svg
        width={svgWidth}
        height={svgHeight}
        style={{ display: 'block', fontFamily: 'inherit' }}
        onMouseLeave={() => setHover(null)}
      >
        {/* Row labels (left) */}
        {modules.map((mod, r) => (
          <text
            key={`row-${r}`}
            x={margin.left - 4}
            y={margin.top + r * cellSize + cellSize / 2}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={Math.max(7, cellSize - 2)}
            fill={dark ? '#94a3b8' : '#475569'}
          >
            {shortLabel(mod)}
          </text>
        ))}

        {/* Column labels (top, rotated 45°) */}
        {modules.map((mod, c) => (
          <text
            key={`col-${c}`}
            x={margin.left + c * cellSize + cellSize / 2}
            y={margin.top - 4}
            textAnchor="start"
            dominantBaseline="auto"
            fontSize={Math.max(7, cellSize - 2)}
            fill={dark ? '#94a3b8' : '#475569'}
            transform={`rotate(-45, ${margin.left + c * cellSize + cellSize / 2}, ${margin.top - 4})`}
          >
            {shortLabel(mod)}
          </text>
        ))}

        {/* Cells */}
        {Array.from({ length: n }, (_, r) =>
          Array.from({ length: n }, (__, c) => {
            const value = matrix[r]?.[c] ?? 0;
            const isDiag = r === c;
            const fill = isDiag ? (dark ? '#334155' : '#e2e8f0') : cellColor(value, maxVal, dark);
            const x = margin.left + c * cellSize;
            const y = margin.top + r * cellSize;
            return (
              <rect
                key={`${r}-${c}`}
                x={x}
                y={y}
                width={cellSize}
                height={cellSize}
                fill={fill}
                stroke={dark ? '#334155' : '#e2e8f0'}
                strokeWidth={0.5}
                onMouseEnter={(e) =>
                  setHover({ row: r, col: c, x: e.clientX, y: e.clientY })
                }
              />
            );
          })
        )}
      </svg>

      {/* Tooltip */}
      {hover !== null && (
        <div
          style={{
            position: 'fixed',
            left: hover.x + 12,
            top: hover.y + 12,
            background: 'rgba(15,23,42,0.9)',
            color: '#f8fafc',
            padding: '4px 8px',
            borderRadius: 4,
            fontSize: 12,
            pointerEvents: 'none',
            zIndex: 50,
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ opacity: 0.7 }}>
            {shortLabel(modules[hover.row] ?? '')}
          </span>
          {' → '}
          <span style={{ opacity: 0.7 }}>
            {shortLabel(modules[hover.col] ?? '')}
          </span>
          {': '}
          <strong>{matrix[hover.row]?.[hover.col] ?? 0}</strong>
        </div>
      )}
    </div>
  );
}
