import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import cytoscape from 'cytoscape';
import cytoscapeDagre from 'cytoscape-dagre';
import { fetchCrossRepoGraph, type CrossRepoGraphData } from '../api/client.ts';

cytoscapeDagre(cytoscape);

interface RepoPairStats {
  source: string;
  target: string;
  count: number;
  packages: string[];
}

function aggregateEdges(data: CrossRepoGraphData): {
  repos: Map<string, { fanIn: number; fanOut: number }>;
  pairs: RepoPairStats[];
} {
  const pairMap = new Map<string, RepoPairStats>();
  const repos = new Map<string, { fanIn: number; fanOut: number }>();

  for (const e of data.edges) {
    const key = `${e.sourceRepo}→${e.targetRepo}`;
    let pair = pairMap.get(key);
    if (!pair) {
      pair = { source: e.sourceRepo, target: e.targetRepo, count: 0, packages: [] };
      pairMap.set(key, pair);
    }
    pair.count++;
    if (e.packageName && !pair.packages.includes(e.packageName)) {
      pair.packages.push(e.packageName);
    }

    if (!repos.has(e.sourceRepo)) repos.set(e.sourceRepo, { fanIn: 0, fanOut: 0 });
    if (!repos.has(e.targetRepo)) repos.set(e.targetRepo, { fanIn: 0, fanOut: 0 });
    repos.get(e.sourceRepo)!.fanOut++;
    repos.get(e.targetRepo)!.fanIn++;
  }

  return { repos, pairs: [...pairMap.values()] };
}

export default function CrossRepoGraphView() {
  const [data, setData] = useState<CrossRepoGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoveredEdge, setHoveredEdge] = useState<RepoPairStats | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const cyRef = useRef<HTMLDivElement>(null);
  const cyInstanceRef = useRef<cytoscape.Core | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const repoFilter = searchParams.get('repo') ?? undefined;

  useEffect(() => {
    let cancelled = false;
    fetchCrossRepoGraph(repoFilter)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repoFilter]);

  useEffect(() => {
    if (!cyRef.current || !data || data.edges.length === 0) return;
    const { repos, pairs } = aggregateEdges(data);

    // Build lookup for tooltip on hover
    const pairLookup = new Map<string, RepoPairStats>();
    for (const p of pairs) pairLookup.set(`${p.source}→${p.target}`, p);

    let maxDegree = 1;
    for (const r of repos.values()) {
      const deg = r.fanIn + r.fanOut;
      if (deg > maxDegree) maxDegree = deg;
    }

    const nodes = [...repos.entries()].map(([name, stats]) => ({
      data: {
        id: name,
        label: name,
        degree: stats.fanIn + stats.fanOut,
        fanIn: stats.fanIn,
        fanOut: stats.fanOut,
        size: 30 + 40 * ((stats.fanIn + stats.fanOut) / maxDegree),
      },
    }));

    const edges = pairs.map((p) => ({
      data: {
        id: `${p.source}→${p.target}`,
        source: p.source,
        target: p.target,
        label: String(p.count),
        weight: p.count,
      },
    }));

    const cy = cytoscape({
      container: cyRef.current,
      elements: [...nodes, ...edges],
      style: [
        {
          selector: 'node',
          style: {
            'background-color': '#3b82f6',
            label: 'data(label)',
            width: 'data(size)',
            height: 'data(size)',
            'font-size': '11px',
            color: '#1e293b',
            'text-valign': 'bottom',
            'text-margin-y': 6,
            'border-width': 2,
            'border-color': '#2563eb',
          } as cytoscape.Css.Node,
        },
        {
          selector: 'edge',
          style: {
            width: 2,
            'line-color': '#94a3b8',
            'target-arrow-color': '#64748b',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            label: 'data(label)',
            'font-size': '9px',
            color: '#64748b',
            'text-background-color': '#ffffff',
            'text-background-opacity': 0.8,
            'text-background-padding': '2px',
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
          style: {
            opacity: 0.3,
          } as cytoscape.Css.Node,
        },
        {
          selector: 'edge.dimmed',
          style: {
            opacity: 0.15,
          } as cytoscape.Css.Edge,
        },
      ],
      layout: {
        name: 'dagre',
        rankDir: 'TB',
        nodeSep: 80,
        rankSep: 100,
      } as cytoscape.LayoutOptions,
      minZoom: 0.3,
      maxZoom: 3,
    });

    // Hover: highlight connected edges
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

    // Hover edge: show tooltip
    cy.on('mouseover', 'edge', (evt) => {
      const edge = evt.target;
      const edgeId = edge.data('id') as string;
      const pair = pairLookup.get(edgeId);
      if (pair) {
        const pos = evt.renderedPosition ?? edge.renderedMidpoint();
        setHoveredEdge(pair);
        setTooltipPos({ x: (pos.x ?? 0) + 12, y: (pos.y ?? 0) + 12 });
      }
    });

    cy.on('mouseout', 'edge', () => {
      setHoveredEdge(null);
    });

    // Click node: navigate to repo detail
    cy.on('tap', 'node', (evt) => {
      const repoName = evt.target.data('id') as string;
      navigate(`/repo/${encodeURIComponent(repoName)}`);
    });

    cyInstanceRef.current = cy;
    return () => { cy.destroy(); cyInstanceRef.current = null; };
  }, [data, navigate]);

  if (loading) return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 p-8 animate-pulse flex items-center justify-center" style={{ minHeight: 400 }}>
      <div className="text-center">
        <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-48 mx-auto mb-3" />
        <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-32 mx-auto" />
      </div>
    </div>
  );
  if (error) return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 p-8 text-center">
      <p className="text-slate-500 dark:text-slate-400">{error}</p>
      <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Run &lsquo;mma index&rsquo; with 2+ repos to generate correlation data.</p>
    </div>
  );

  const { repos, pairs } = data ? aggregateEdges(data) : { repos: new Map(), pairs: [] };
  const topLinchpins = [...repos.entries()]
    .sort((a, b) => b[1].fanIn - a[1].fanIn)
    .slice(0, 5);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">
          Cross-Repo Dependency Graph
          {repoFilter && <span className="text-sm font-normal text-slate-500 dark:text-slate-400 ml-2">(filtered: {repoFilter})</span>}
        </h2>
        {repoFilter && (
          <button
            onClick={() => navigate('/cross-repo')}
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            Show all
          </button>
        )}
      </div>

      {!data || data.edges.length === 0 ? (
        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 p-8 text-center text-slate-400 dark:text-slate-500">
          No cross-repo dependency data available. Run <code className="font-mono text-xs bg-slate-100 dark:bg-slate-700 px-1 rounded">mma index</code> with 2+ repos to generate correlation data.
        </div>
      ) : (
        <div className="flex gap-4">
          {/* Graph */}
          <div className="flex-1 bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 relative" style={{ minHeight: 500 }}>
            <div ref={cyRef} style={{ width: '100%', height: 500 }} />
            {hoveredEdge && (
              <div
                style={{
                  position: 'absolute',
                  left: tooltipPos.x,
                  top: tooltipPos.y,
                  background: 'rgba(15,23,42,0.9)',
                  color: '#f8fafc',
                  padding: '6px 10px',
                  borderRadius: 6,
                  fontSize: 12,
                  pointerEvents: 'none',
                  zIndex: 50,
                  maxWidth: 300,
                }}
              >
                <div className="font-medium">{hoveredEdge.source} → {hoveredEdge.target}</div>
                <div className="text-slate-300">{hoveredEdge.count} edge{hoveredEdge.count !== 1 ? 's' : ''}</div>
                {hoveredEdge.packages.length > 0 && (
                  <div className="text-slate-400 mt-1">
                    {hoveredEdge.packages.slice(0, 5).join(', ')}
                    {hoveredEdge.packages.length > 5 && ` +${hoveredEdge.packages.length - 5} more`}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="w-64 space-y-4">
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Summary</h3>
              <div className="space-y-1 text-sm text-slate-600 dark:text-slate-400">
                <div><span className="font-medium text-slate-800 dark:text-slate-200">{repos.size}</span> repos</div>
                <div><span className="font-medium text-slate-800 dark:text-slate-200">{pairs.length}</span> dependency pairs</div>
                <div><span className="font-medium text-slate-800 dark:text-slate-200">{data.edges.length}</span> total edges</div>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Top Dependencies (by fan-in)</h3>
              <div className="space-y-2">
                {topLinchpins.map(([name, stats]) => (
                  <button
                    key={name}
                    onClick={() => navigate(`/repo/${encodeURIComponent(name)}`)}
                    className="block w-full text-left hover:bg-slate-50 dark:hover:bg-slate-700 rounded px-2 py-1 -mx-2"
                  >
                    <div className="text-sm font-medium text-slate-700 dark:text-slate-300 truncate">{name}</div>
                    <div className="text-xs text-slate-400 dark:text-slate-500">
                      {stats.fanIn} in / {stats.fanOut} out
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
