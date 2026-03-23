import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import cytoscape from 'cytoscape';
import cytoscapeDagre from 'cytoscape-dagre';
import { fetchGraph } from '../api/client.ts';
import { GraphControls } from './shared/GraphControls.tsx';

cytoscapeDagre(cytoscape);

const EDGE_KINDS = [
  'imports',
  'calls',
  'extends',
  'implements',
  'depends-on',
  'service-call',
] as const;

interface Edge {
  source: string;
  target: string;
  kind: string;
  metadata?: Record<string, unknown>;
}

function lastSegment(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

export default function DependencyGraph() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<string>('imports');
  const [topN, setTopN] = useState(50);
  const cyRef = useRef<HTMLDivElement>(null);
  const cyInstanceRef = useRef<cytoscape.Core | null>(null);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchGraph(name, selectedKind)
      .then((d) => { if (!cancelled) setEdges(d.edges as Edge[]); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [name, selectedKind]);

  // Compute degree map and filtered nodes/edges based on topN
  const { filteredNodes, filteredEdges, totalNodeCount } = useMemo(() => {
    if (edges.length === 0) return { filteredNodes: [], filteredEdges: [], totalNodeCount: 0 };

    const degreeMap = new Map<string, number>();
    for (const e of edges) {
      degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1);
      degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1);
    }

    const total = degreeMap.size;

    // Keep only top N nodes by degree
    const sorted = [...degreeMap.entries()].sort((a, b) => b[1] - a[1]);
    const kept = new Set(sorted.slice(0, topN).map(([id]) => id));

    let maxDegree = 1;
    for (const [, d] of sorted.slice(0, topN)) {
      if (d > maxDegree) maxDegree = d;
    }

    const nodes = sorted.slice(0, topN).map(([id, degree]) => ({
      data: {
        id,
        label: lastSegment(id),
        degree,
        size: 20 + 30 * (degree / maxDegree),
      },
    }));

    const cyEdges = edges
      .filter((e) => kept.has(e.source) && kept.has(e.target))
      .map((e, i) => ({
        data: { id: `e${i}`, source: e.source, target: e.target },
      }));

    return { filteredNodes: nodes, filteredEdges: cyEdges, totalNodeCount: total };
  }, [edges, topN]);

  useEffect(() => {
    if (!cyRef.current || filteredNodes.length === 0) return;

    const cy = cytoscape({
      container: cyRef.current,
      elements: [...filteredNodes, ...filteredEdges],
      style: [
        {
          selector: 'node',
          style: {
            'background-color': '#3b82f6',
            label: 'data(label)',
            width: 'data(size)',
            height: 'data(size)',
            'font-size': '11px',
            color: '#e2e8f0',
            'text-valign': 'bottom',
            'text-outline-color': '#0f172a',
            'text-outline-width': 1,
            'text-margin-y': 5,
            'border-width': 2,
            'border-color': '#2563eb',
          } as cytoscape.Css.Node,
        },
        {
          selector: 'edge',
          style: {
            width: 1.5,
            'line-color': '#94a3b8',
            'target-arrow-color': '#64748b',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
          } as cytoscape.Css.Edge,
        },
        {
          selector: 'node.highlighted',
          style: {
            'background-color': '#2563eb',
            'border-color': '#1d4ed8',
            'border-width': 3,
          } as cytoscape.Css.Node,
        },
        {
          selector: 'edge.highlighted',
          style: {
            width: 3,
            'line-color': '#2563eb',
            'target-arrow-color': '#1d4ed8',
          } as cytoscape.Css.Edge,
        },
        {
          selector: 'node.dimmed',
          style: { opacity: 0.3 } as cytoscape.Css.Node,
        },
        {
          selector: 'edge.dimmed',
          style: { opacity: 0.15 } as cytoscape.Css.Edge,
        },
      ],
      layout: {
        name: 'dagre',
        rankDir: 'LR',
        nodeSep: 60,
        rankSep: 80,
      } as cytoscape.LayoutOptions,
      minZoom: 0.2,
      maxZoom: 3,
    });

    // Hover: highlight connected edges + nodes
    cy.on('mouseover', 'node', (evt) => {
      const node = evt.target;
      const connected = node.connectedEdges();
      const connectedNodes = connected.connectedNodes();
      cy.elements().addClass('dimmed');
      node.removeClass('dimmed').addClass('highlighted');
      connected.removeClass('dimmed').addClass('highlighted');
      connectedNodes.removeClass('dimmed').addClass('highlighted');
    });

    cy.on('mouseout', 'node', () => {
      cy.elements().removeClass('dimmed highlighted');
    });

    // Click node: navigate to module detail
    cy.on('tap', 'node', (evt) => {
      const moduleId = evt.target.data('id') as string;
      if (!name) return;
      navigate(`/repo/${encodeURIComponent(name)}/module/${encodeURIComponent(moduleId)}`);
    });

    cyInstanceRef.current = cy;
    return () => {
      cy.destroy();
      cyInstanceRef.current = null;
    };
  }, [filteredNodes, filteredEdges, navigate, name]);

  if (loading) return <p className="text-slate-500 dark:text-slate-400">Loading dependency graph...</p>;
  if (error) return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 p-8 text-center">
      <p className="text-red-500">{error}</p>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">
          Dependency Graph — {name}
        </h2>
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Showing {filteredNodes.length} of {totalNodeCount} nodes · {filteredEdges.length} edges
          </span>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            Top N:
            <input
              type="range"
              min={10}
              max={200}
              step={10}
              value={topN}
              onChange={(e) => setTopN(Number(e.target.value))}
              className="w-24"
            />
            <span className="w-8 text-right font-mono dark:text-slate-300">{topN}</span>
          </label>
          <select
            value={selectedKind}
            onChange={(e) => setSelectedKind(e.target.value)}
            className="text-sm border border-slate-300 dark:border-slate-600 rounded px-2 py-1 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-300"
          >
            {EDGE_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
      </div>

      {edges.length === 0 ? (
        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 p-8 text-center text-slate-400 dark:text-slate-500">
          No {selectedKind} edges found for this repository.
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 relative" style={{ minHeight: 500 }}>
          <div ref={cyRef} style={{ width: '100%', height: 600 }} />
          <GraphControls cyInstanceRef={cyInstanceRef} />
        </div>
      )}
    </div>
  );
}
