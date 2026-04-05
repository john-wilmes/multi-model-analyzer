import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { cytoscape, ensureDagreRegistered } from '../lib/cytoscape-setup.ts';
import { fetchCrossRepoGraph, fetchAtdi, fetchRepoStates, type CrossRepoGraphData, type AtdiRepoScore, type RepoStateInfo } from '../api/client.ts';
import { GraphControls } from './shared/GraphControls.tsx';

// Debounce helper (avoids external deps)
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

ensureDagreRegistered();

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

// ── B1: Cluster utilities ────────────────────────────────────────────────────

/** Group repo names by their first name segment (split on -, /, .). */
export function clusterRepos(repoNames: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const name of repoNames) {
    const key = name.split(/[-/.]/)[0] ?? name;
    let members = groups.get(key);
    if (!members) { members = []; groups.set(key, members); }
    members.push(name);
  }

  // Merge single-member clusters into "other"
  const result = new Map<string, string[]>();
  const orphans: string[] = [];
  for (const [key, members] of groups) {
    if (members.length >= 2) {
      result.set(key, members);
    } else {
      orphans.push(...members);
    }
  }
  if (orphans.length > 0) result.set('other', orphans);
  return result;
}

// ── B4: Node sizing utilities ────────────────────────────────────────────────

type SizeMetric = 'findings' | 'modules' | 'fan-in' | 'fan-out';

const NODE_MIN = 20;
const NODE_MAX = 60;

function logNormalize(value: number, maxValue: number): number {
  if (value === 0 || maxValue === 0) return NODE_MIN;
  return NODE_MIN + (NODE_MAX - NODE_MIN) * (Math.log(value + 1) / Math.log(maxValue + 1));
}

function computeNodeSizes(
  repoNames: string[],
  metric: SizeMetric,
  repos: Map<string, { fanIn: number; fanOut: number }>,
  atdiByRepo: Map<string, AtdiRepoScore>,
): Map<string, number> {
  const rawValues = new Map<string, number>();

  for (const name of repoNames) {
    const stats = repos.get(name);
    const atdi = atdiByRepo.get(name);
    let value = 0;
    switch (metric) {
      case 'fan-in':
        value = stats?.fanIn ?? 0;
        break;
      case 'fan-out':
        value = stats?.fanOut ?? 0;
        break;
      case 'findings': {
        const fc = atdi?.findingCounts;
        value = fc ? (fc.error + fc.warning + fc.note) : 0;
        break;
      }
      case 'modules':
        value = atdi?.moduleCount ?? 0;
        break;
    }
    rawValues.set(name, value);
  }

  const maxValue = Math.max(...rawValues.values(), 1);
  const sizes = new Map<string, number>();
  for (const [name, value] of rawValues) {
    sizes.set(name, logNormalize(value, maxValue));
  }
  return sizes;
}

/** Health color for a repo node based on error finding count. */
function healthColor(atdi: AtdiRepoScore | undefined): string {
  if (!atdi) return '#6b7280'; // gray — no data
  const errors = atdi.findingCounts.error;
  if (errors === 0) return '#22c55e';   // green
  if (errors <= 5) return '#eab308';   // yellow
  return '#ef4444';                     // red
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CrossRepoGraphView() {
  const [data, setData] = useState<CrossRepoGraphData | null>(null);
  const [atdiByRepo, setAtdiByRepo] = useState<Map<string, AtdiRepoScore>>(new Map());
  const [repoStates, setRepoStates] = useState<RepoStateInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoveredEdge, setHoveredEdge] = useState<RepoPairStats | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebounce(searchQuery, 200);

  // B1: Cluster view controls
  const [viewMode, setViewMode] = useState<'flat' | 'cluster'>('flat');
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  // B4: Node sizing
  const [sizeMetric, setSizeMetric] = useState<SizeMetric>('findings');

  const cyRef = useRef<HTMLDivElement | null>(null);
  const cyInstanceRef = useRef<cytoscape.Core | undefined>(undefined);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const repoFilter = searchParams.get('repo') ?? undefined;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    Promise.all([
      fetchCrossRepoGraph(repoFilter),
      fetchAtdi(),
      fetchRepoStates(),
    ]).then(([graphData, atdiData, stateData]) => {
      if (cancelled) return;
      setData(graphData);
      if (atdiData) {
        const m = new Map<string, AtdiRepoScore>();
        for (const r of atdiData.repoScores) m.set(r.repo, r);
        setAtdiByRepo(m);
      }
      setRepoStates(stateData.states);
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [repoFilter]);

  // Auto-switch to cluster mode when there are 15+ repos
  useEffect(() => {
    if (!data) return;
    const { repos } = aggregateEdges(data);
    if (repos.size >= 15) setViewMode('cluster');
  }, [data]);

  const toggleCluster = useCallback((clusterId: string) => {
    setExpandedClusters((prev) => {
      const next = new Set(prev);
      if (next.has(clusterId)) next.delete(clusterId);
      else next.add(clusterId);
      return next;
    });
  }, []);

  // Graph creation effect — rebuilds the graph when structure changes
  useEffect(() => {
    const hasGhostNodes = repoStates.some((rs) => rs.status === 'candidate' || rs.status === 'indexing');
    if (!cyRef.current || !data || (data.edges.length === 0 && !hasGhostNodes)) return;
    const { repos, pairs } = aggregateEdges(data);
    const repoNames = [...repos.keys()];

    const pairLookup = new Map<string, RepoPairStats>();
    for (const p of pairs) pairLookup.set(`${p.source}→${p.target}`, p);

    const sizes = computeNodeSizes(repoNames, sizeMetric, repos, atdiByRepo);

    let elements: cytoscape.ElementDefinition[];
    let layoutName: string;
    let layoutOpts: Record<string, unknown>;
    let isClusterMode = false;

    if (viewMode === 'cluster') {
      isClusterMode = true;
      const clusters = clusterRepos(repoNames);

      elements = [];
      for (const [clusterName, members] of clusters) {
        const clusterId = `cluster:${clusterName}`;
        const isExpanded = expandedClusters.has(clusterId);
        elements.push({
          data: {
            id: clusterId,
            label: isExpanded
              ? clusterName
              : `${clusterName} (${members.length})`,
            isCluster: true,
            memberCount: members.length,
          },
          classes: 'cluster',
        });

        if (isExpanded) {
          for (const member of members) {
            const sz = sizes.get(member) ?? NODE_MIN;
            elements.push({
              data: {
                id: member,
                label: member,
                parent: clusterId,
                size: sz,
                color: healthColor(atdiByRepo.get(member)),
              },
            });
          }
        }
      }

      const clusterOf = new Map<string, string>();
      for (const [clusterName, members] of clusters) {
        const clusterId = `cluster:${clusterName}`;
        for (const m of members) {
          clusterOf.set(m, expandedClusters.has(clusterId) ? m : clusterId);
        }
      }

      const clusterEdgeMap = new Map<string, { count: number; packages: string[] }>();
      for (const p of pairs) {
        const src = clusterOf.get(p.source) ?? p.source;
        const tgt = clusterOf.get(p.target) ?? p.target;
        if (src === tgt) continue;
        const key = `${src}→${tgt}`;
        let entry = clusterEdgeMap.get(key);
        if (!entry) {
          entry = { count: 0, packages: [] };
          clusterEdgeMap.set(key, entry);
        }
        entry.count += p.count;
        for (const pkg of p.packages) {
          if (!entry.packages.includes(pkg)) entry.packages.push(pkg);
        }
      }

      // Add cluster-level entries to pairLookup for tooltip resolution
      for (const [key, entry] of clusterEdgeMap) {
        const arrowIdx = key.indexOf('→');
        const src = key.slice(0, arrowIdx);
        const tgt = key.slice(arrowIdx + 1);
        pairLookup.set(key, { source: src, target: tgt, count: entry.count, packages: entry.packages });
      }

      let edgeIdx = 0;
      for (const [key, entry] of clusterEdgeMap) {
        const arrowIdx = key.indexOf('→');
        const src = key.slice(0, arrowIdx);
        const tgt = key.slice(arrowIdx + 1);
        elements.push({
          data: {
            id: `ce-${edgeIdx++}`,
            source: src,
            target: tgt,
            label: String(entry.count),
            weight: entry.count,
            pairKey: key,
          },
        });
      }

      for (const rs of repoStates) {
        if (rs.status === 'ignored' || rs.status === 'indexed') continue;
        if (repos.has(rs.name)) continue;
        elements.push({
          data: {
            id: rs.name,
            label: rs.name,
            size: NODE_MIN,
            color: rs.status === 'indexing' ? '#3b82f6' : '#475569',
            repoStatus: rs.status,
          },
          classes: rs.status === 'indexing' ? 'indexing-node' : 'candidate-node',
        });
      }

      layoutName = 'cose';
      layoutOpts = { animate: false, nodeRepulsion: 4000, idealEdgeLength: 100 };
    } else {
      elements = repoNames.map((name) => {
        const sz = sizes.get(name) ?? NODE_MIN;
        return {
          data: {
            id: name,
            label: name,
            size: sz,
            color: healthColor(atdiByRepo.get(name)),
          },
        };
      });
      elements.push(
        ...pairs.map((p) => ({
          data: {
            id: `${p.source}→${p.target}`,
            source: p.source,
            target: p.target,
            label: String(p.count),
            weight: p.count,
          },
        })),
      );

      for (const rs of repoStates) {
        if (rs.status === 'ignored' || rs.status === 'indexed') continue;
        if (repos.has(rs.name)) continue;
        elements.push({
          data: {
            id: rs.name,
            label: rs.name,
            size: NODE_MIN,
            color: rs.status === 'indexing' ? '#3b82f6' : '#475569',
            repoStatus: rs.status,
          },
          classes: rs.status === 'indexing' ? 'indexing-node' : 'candidate-node',
        });
      }

      layoutName = 'dagre';
      layoutOpts = { rankDir: 'TB', nodeSep: 80, rankSep: 100 };
    }

    const cy = cytoscape({
      container: cyRef.current,
      elements,
      pixelRatio: 1,
      textureOnViewport: true,
      hideEdgesOnViewport: true,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            label: 'data(label)',
            width: 'data(size)',
            height: 'data(size)',
            'font-size': '12px',
            color: '#e2e8f0',
            'text-valign': 'bottom',
            'text-outline-color': '#0f172a',
            'text-outline-width': 2,
            'text-margin-y': 6,
            'border-width': 2,
            'border-color': '#2563eb',
            'min-zoomed-font-size': 6,
          } as cytoscape.Css.Node,
        },
        {
          selector: 'node.cluster',
          style: {
            'background-color': '#334155',
            'border-color': '#64748b',
            'border-width': 2,
            'border-style': 'dashed',
            label: 'data(label)',
            'font-size': '13px',
            'font-weight': 'bold',
            color: '#cbd5e1',
            'text-valign': 'center',
            'text-halign': 'center',
            width: 80,
            height: 80,
            shape: 'roundrectangle',
          } as cytoscape.Css.Node,
        },
        {
          selector: 'edge',
          style: {
            width: 2,
            'line-color': '#94a3b8',
            'target-arrow-color': '#64748b',
            'target-arrow-shape': 'triangle',
            'curve-style': 'haystack',
            label: 'data(label)',
            'font-size': '9px',
            color: '#cbd5e1',
            'text-background-color': '#1e293b',
            'text-background-opacity': 0.8,
            'text-background-padding': '2px',
          } as cytoscape.Css.Edge,
        },
        {
          selector: 'node.candidate-node',
          style: {
            'background-color': '#475569',
            'border-width': 2,
            'border-style': 'dashed',
            'border-color': '#64748b',
            opacity: 0.5,
            'font-style': 'italic',
          } as cytoscape.Css.Node,
        },
        {
          selector: 'node.indexing-node',
          style: {
            'background-color': '#3b82f6',
            'border-width': 3,
            'border-color': '#60a5fa',
            'border-style': 'solid',
          } as cytoscape.Css.Node,
        },
        {
          selector: 'node.highlighted',
          style: {
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
        name: layoutName,
        ...layoutOpts,
      } as cytoscape.LayoutOptions,
      minZoom: 0.3,
      maxZoom: 3,
    });

    const indexingNodes = cy.nodes('.indexing-node');
    if (indexingNodes.length > 0) {
      let pulseState = true;
      const pulseInterval = setInterval(() => {
        pulseState = !pulseState;
        indexingNodes.style('opacity', pulseState ? 1 : 0.4);
      }, 800);
      cy.on('destroy', () => clearInterval(pulseInterval));
    }

    cy.on('mouseover', 'node', (evt) => {
      const node = evt.target as cytoscape.NodeSingular;
      if (node.data('isCluster') as boolean) return;
      const connected = node.connectedEdges();
      const connectedNodes = connected.connectedNodes();
      cy.batch(() => {
        cy.elements().addClass('dimmed');
        node.removeClass('dimmed').addClass('highlighted');
        connected.removeClass('dimmed').addClass('highlighted');
        connectedNodes.removeClass('dimmed').addClass('highlighted');
      });
    });

    cy.on('mouseout', 'node', () => {
      cy.batch(() => {
        cy.elements().removeClass('dimmed highlighted');
      });
    });

    cy.on('mouseover', 'edge', (evt) => {
      const edge = evt.target as cytoscape.EdgeSingular;
      const lookupKey = (edge.data('pairKey') as string | undefined) ?? (edge.data('id') as string);
      const pair = pairLookup.get(lookupKey);
      if (pair) {
        const pos = evt.renderedPosition ?? edge.renderedMidpoint();
        setHoveredEdge(pair);
        setTooltipPos({ x: (pos.x ?? 0) + 12, y: (pos.y ?? 0) + 12 });
      }
    });

    cy.on('mouseout', 'edge', () => {
      setHoveredEdge(null);
    });

    cy.on('tap', 'node', (evt) => {
      const node = evt.target as cytoscape.NodeSingular;
      if (isClusterMode && (node.data('isCluster') as boolean)) {
        toggleCluster(node.data('id') as string);
      } else if (!(node.data('isCluster') as boolean)) {
        navigate(`/repo/${encodeURIComponent(node.data('id') as string)}`);
      }
    });

    cyInstanceRef.current = cy;
    return () => { cy.destroy(); cyInstanceRef.current = undefined; };
  }, [data, navigate, viewMode, expandedClusters, toggleCluster, repoStates]); // eslint-disable-line react-hooks/exhaustive-deps

  // Style update effect — updates node sizes/colors without recreating the graph
  useEffect(() => {
    const cy = cyInstanceRef.current;
    if (!cy || !data) return;
    const { repos } = aggregateEdges(data);
    const repoNames = [...repos.keys()];
    const sizes = computeNodeSizes(repoNames, sizeMetric, repos, atdiByRepo);

    cy.batch(() => {
      for (const node of cy.nodes().toArray()) {
        if (node.data('isCluster') as boolean) continue;
        if (node.data('repoStatus')) continue;
        const name = node.data('id') as string;
        const sz = sizes.get(name) ?? NODE_MIN;
        node.data('size', sz);
        node.data('color', healthColor(atdiByRepo.get(name)));
      }
    });
  }, [sizeMetric, atdiByRepo, data]);

  // B2: Search-to-focus — filter node opacity based on debounced search query
  useEffect(() => {
    const cy = cyInstanceRef.current;
    if (!cy) return;
    cy.batch(() => {
      if (!debouncedSearch.trim()) {
        cy.elements().style({ opacity: 1 });
        return;
      }
      const query = debouncedSearch.toLowerCase();
      // Collect matching node IDs first
      const matchingIds = new Set<string>();
      cy.nodes().forEach((node) => {
        const match = (node.data('label') as string | undefined)?.toLowerCase().includes(query) ?? false;
        if (match) matchingIds.add(node.id());
        node.style('opacity', match ? 1 : 0.15);
      });
      // Style edges: visible if either endpoint matches
      cy.edges().forEach((edge) => {
        const srcMatch = matchingIds.has(edge.data('source') as string);
        const tgtMatch = matchingIds.has(edge.data('target') as string);
        edge.style('opacity', (srcMatch || tgtMatch) ? 0.7 : 0.08);
      });
    });
  }, [debouncedSearch, data, viewMode, sizeMetric, expandedClusters, repoStates]);

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
  const allSorted = [...repos.entries()].sort((a, b) => b[1].fanIn - a[1].fanIn);
  const topLinchpins = allSorted.slice(0, 10);

  // Symbol resolution coverage
  const totalEdges = data?.edges.length ?? 0;
  const resolvedEdges = data?.edges.filter(
    (e) => e.edge.metadata?.resolvedSymbols && e.edge.metadata.resolvedSymbols.length > 0
  ).length ?? 0;
  const resolutionPct = totalEdges > 0 ? Math.round((resolvedEdges / totalEdges) * 100) : 0;

  return (
    <div className="space-y-4 min-w-0">
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

      {(!data || data.edges.length === 0) && !repoStates.some((rs) => rs.status === 'candidate' || rs.status === 'indexing') ? (
        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 p-8 text-center text-slate-400 dark:text-slate-500">
          No cross-repo dependency data available. Run <code className="font-mono text-xs bg-slate-100 dark:bg-slate-700 px-1 rounded">mma index</code> with 2+ repos to generate correlation data.
        </div>
      ) : (
        <div className="flex gap-4 min-w-0 overflow-x-auto">
          {/* Graph */}
          <div className="flex-1 min-w-0 bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 relative" style={{ minHeight: 500 }}>

            {/* Controls toolbar */}
            <div className="flex items-center gap-3 p-2 border-b border-slate-200 dark:border-slate-700 flex-wrap">
              {/* B2: Search bar */}
              <input
                type="text"
                placeholder="Search repos..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-36 px-2 py-1 text-xs rounded bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-label="Search graph repos"
              />

              {/* B1: View mode toggle */}
              <div className="flex rounded overflow-hidden border border-gray-600">
                <button
                  aria-pressed={viewMode === 'flat'}
                  onClick={() => setViewMode('flat')}
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    viewMode === 'flat'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
                  }`}
                >
                  Flat
                </button>
                <button
                  aria-pressed={viewMode === 'cluster'}
                  onClick={() => { setViewMode('cluster'); setExpandedClusters(new Set()); }}
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    viewMode === 'cluster'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
                  }`}
                >
                  Cluster
                </button>
              </div>

              {/* B4: Size metric selector */}
              <div className="flex items-center gap-1">
                <label htmlFor="size-metric" className="text-xs text-gray-400 dark:text-gray-400 whitespace-nowrap">Size by</label>
                <select
                  id="size-metric"
                  value={sizeMetric}
                  onChange={(e) => setSizeMetric(e.target.value as SizeMetric)}
                  className="text-xs bg-gray-700 text-gray-200 border border-gray-600 rounded px-2 py-1"
                >
                  <option value="findings">SARIF Findings</option>
                  <option value="modules">Module Count</option>
                  <option value="fan-in">Fan-in</option>
                  <option value="fan-out">Fan-out</option>
                </select>
              </div>

              {/* B4: Health color legend */}
              <div className="flex items-center gap-2 ml-auto flex-wrap">
                <span className="text-xs text-gray-400">Health:</span>
                <span className="flex items-center gap-1 text-xs text-gray-300">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" /> 0 errors
                </span>
                <span className="flex items-center gap-1 text-xs text-gray-300">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-yellow-500" /> 1-5
                </span>
                <span className="flex items-center gap-1 text-xs text-gray-300">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" /> 6+
                </span>
                <span className="flex items-center gap-1 text-xs text-gray-300">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-500" /> n/a
                </span>
                {/* B7: Repo state legend */}
                {repoStates.some((rs) => rs.status === 'candidate' || rs.status === 'indexing') && (
                  <>
                    <span className="ml-2 pl-2 border-l border-gray-600 text-xs text-gray-400">State:</span>
                    <span className="flex items-center gap-1 text-xs text-gray-300">
                      <span className="inline-block w-2.5 h-2.5 rounded border border-dashed border-slate-400 bg-slate-600 opacity-50" /> Candidate
                    </span>
                    <span className="flex items-center gap-1 text-xs text-gray-300">
                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" /> Indexing
                    </span>
                  </>
                )}
              </div>
            </div>

            {viewMode === 'cluster' && expandedClusters.size > 0 && (
              <div className="px-3 py-1 text-xs text-gray-400 bg-slate-900 border-b border-slate-700">
                Click cluster to collapse. Expanded: {[...expandedClusters].map((id) => id.replace('cluster:', '')).join(', ')}
              </div>
            )}

            <div ref={cyRef} style={{ width: '100%', height: 500 }} />
            <GraphControls cyInstanceRef={cyInstanceRef} />

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
                <div><span className="font-medium text-slate-800 dark:text-slate-200">{data?.edges.length ?? 0}</span> total edges</div>
                {totalEdges > 0 && (
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-slate-800 dark:text-slate-200">{resolutionPct}%</span> symbols resolved
                    <span className="text-xs text-slate-400">({resolvedEdges}/{totalEdges})</span>
                  </div>
                )}
                {repoStates.length > 0 && (
                  <>
                    <div className="border-t border-slate-200 dark:border-slate-700 my-2" />
                    <div><span className="font-medium text-slate-800 dark:text-slate-200">{repoStates.filter(s => s.status === 'candidate').length}</span> candidates</div>
                    <div><span className="font-medium text-slate-800 dark:text-slate-200">{repoStates.filter(s => s.status === 'indexing').length}</span> indexing</div>
                    <div><span className="font-medium text-slate-800 dark:text-slate-200">{repoStates.filter(s => s.status === 'indexed').length}</span> indexed</div>
                    <div><span className="font-medium text-slate-800 dark:text-slate-200">{repoStates.filter(s => s.status === 'ignored').length}</span> ignored</div>
                  </>
                )}
              </div>
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">
                Top Dependencies (by fan-in)
                {allSorted.length > topLinchpins.length && (
                  <span className="font-normal text-slate-400 dark:text-slate-500 ml-1">
                    ({topLinchpins.length} of {allSorted.length})
                  </span>
                )}
              </h3>
              <div className="space-y-2">
                {topLinchpins.map(([name, stats]) => (
                  <button
                    key={name}
                    onClick={() => navigate(`/repo/${encodeURIComponent(name)}`)}
                    className="block w-full text-left hover:bg-slate-50 dark:hover:bg-slate-700 rounded px-2 py-1 -mx-2"
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: healthColor(atdiByRepo.get(name)) }}
                      />
                      <span className="text-sm font-medium text-slate-700 dark:text-slate-300 truncate">{name}</span>
                    </div>
                    <div className="text-xs text-slate-400 dark:text-slate-500 ml-3.5">
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
