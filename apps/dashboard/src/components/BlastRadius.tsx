import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import cytoscape from 'cytoscape';
import {
  fetchBlastRadiusOverview,
  fetchBlastRadius,
  fetchRepos,
} from '../api/client.ts';
import type {
  BlastRadiusOverviewFile,
  BlastRadiusAffectedFile,
} from '../api/client.ts';
import { GraphControls } from './shared/GraphControls.tsx';

function lastSegment(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

function depthColor(depth: number): string {
  if (depth === 0) return '#ef4444'; // red — root
  if (depth === 1) return '#f97316'; // orange
  if (depth === 2) return '#eab308'; // yellow
  return '#94a3b8'; // grey
}

function depthBorder(depth: number): string {
  if (depth === 0) return '#b91c1c';
  if (depth === 1) return '#c2410c';
  if (depth === 2) return '#a16207';
  return '#64748b';
}

export default function BlastRadius() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();

  const [repos, setRepos] = useState<string[]>([]);
  const routeRepo = name ?? '';
  const [selectedRepo, setSelectedRepo] = useState(routeRepo);
  const [maxDepth, setMaxDepth] = useState(5);

  // Sync selectedRepo when route param changes (back/forward nav)
  useEffect(() => {
    setSelectedRepo(routeRepo);
  }, [routeRepo]);

  const [overviewFiles, setOverviewFiles] = useState<BlastRadiusOverviewFile[]>([]);
  const [totalNodes, setTotalNodes] = useState(0);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [affectedFiles, setAffectedFiles] = useState<BlastRadiusAffectedFile[]>([]);
  const [changedFiles, setChangedFiles] = useState<string[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const cyRef = useRef<HTMLDivElement>(null);
  const cyInstanceRef = useRef<cytoscape.Core | null>(null);

  // Load repos
  useEffect(() => {
    fetchRepos()
      .then((d) => {
        setRepos(d.repos);
        if (d.repos.length > 0) setSelectedRepo((prev) => prev || d.repos[0]!);
      })
      .catch(() => setRepos([]));
  }, []);

  // Update URL when repo changes
  useEffect(() => {
    if (selectedRepo && selectedRepo !== routeRepo) {
      navigate(`/blast-radius/${encodeURIComponent(selectedRepo)}`, { replace: true });
    }
  }, [selectedRepo, routeRepo, navigate]);

  // Fetch overview when repo changes
  useEffect(() => {
    if (!selectedRepo) return;
    let cancelled = false;
    setOverviewLoading(true);
    setOverviewError(null);
    setSelectedFile(null);
    setAffectedFiles([]);

    fetchBlastRadiusOverview(selectedRepo)
      .then((data) => {
        if (!cancelled) {
          setOverviewFiles(data.files);
          setTotalNodes(data.totalNodes);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setOverviewError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => { if (!cancelled) setOverviewLoading(false); });

    return () => { cancelled = true; };
  }, [selectedRepo]);

  // Fetch detail when file selected or depth changes
  useEffect(() => {
    if (!selectedRepo || !selectedFile) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);

    fetchBlastRadius(selectedRepo, selectedFile, maxDepth)
      .then((data) => {
        if (!cancelled) {
          setAffectedFiles(data.affectedFiles);
          setChangedFiles(data.changedFiles);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => { if (!cancelled) setDetailLoading(false); });

    return () => { cancelled = true; };
  }, [selectedRepo, selectedFile, maxDepth]);

  // Render Cytoscape graph
  useEffect(() => {
    if (!cyRef.current || affectedFiles.length === 0 || !selectedFile) return;

    // Build node data: root + affected files
    const nodeMap = new Map<string, { depth: number; score: number; via: string }>();
    for (const f of changedFiles) {
      nodeMap.set(f, { depth: 0, score: 0, via: 'source' });
    }
    for (const f of affectedFiles) {
      nodeMap.set(f.path, { depth: f.depth, score: f.score, via: f.via });
    }

    // Find max score for sizing
    let maxScore = 0;
    for (const n of nodeMap.values()) {
      if (n.score > maxScore) maxScore = n.score;
    }
    if (maxScore === 0) maxScore = 1;

    const nodes = [...nodeMap.entries()].map(([id, info]) => ({
      data: {
        id,
        label: lastSegment(id),
        depth: info.depth,
        nodeScore: info.score,
        via: info.via,
        size: 20 + 30 * (info.score / maxScore),
      },
    }));

    const cy = cytoscape({
      container: cyRef.current,
      elements: nodes,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            width: 'data(size)',
            height: 'data(size)',
            'background-color': (ele: cytoscape.NodeSingular) => depthColor(ele.data('depth') as number),
            'border-width': 2,
            'border-color': (ele: cytoscape.NodeSingular) => depthBorder(ele.data('depth') as number),
            'font-size': '9px',
            color: '#1e293b',
            'text-valign': 'bottom',
            'text-margin-y': 5,
          } as cytoscape.Css.Node,
        },
        {
          selector: 'node.highlighted',
          style: {
            'border-width': 3,
            'border-color': '#1d4ed8',
          } as cytoscape.Css.Node,
        },
        {
          selector: 'node.dimmed',
          style: { opacity: 0.3 } as cytoscape.Css.Node,
        },
      ],
      layout: {
        name: 'concentric',
        concentric: (node: cytoscape.NodeSingular) => -(node.data('depth') as number),
        levelWidth: () => 1,
        minNodeSpacing: 30,
      } as cytoscape.LayoutOptions,
      minZoom: 0.2,
      maxZoom: 3,
    });

    // Hover: highlight same-depth nodes
    cy.on('mouseover', 'node', (evt) => {
      const node = evt.target;
      const depth = node.data('depth') as number;
      cy.elements().addClass('dimmed');
      node.removeClass('dimmed').addClass('highlighted');
      cy.nodes().filter((n: cytoscape.NodeSingular) => (n.data('depth') as number) === depth).removeClass('dimmed');
    });

    cy.on('mouseout', 'node', () => {
      cy.elements().removeClass('dimmed highlighted');
    });

    // Click node: navigate to module detail
    cy.on('tap', 'node', (evt) => {
      const moduleId = evt.target.data('id') as string;
      if (!selectedRepo) return;
      navigate(`/repo/${encodeURIComponent(selectedRepo)}/module/${encodeURIComponent(moduleId)}`);
    });

    cyInstanceRef.current = cy;
    return () => {
      cy.destroy();
      cyInstanceRef.current = null;
    };
  }, [affectedFiles, changedFiles, selectedFile, selectedRepo, navigate]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Blast Radius</h2>
        <div className="flex items-center gap-3">
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="text-sm border border-slate-300 dark:border-slate-600 rounded px-2 py-1 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-300"
          >
            {repos.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            Depth:
            <input
              type="range"
              min={1}
              max={10}
              value={maxDepth}
              onChange={(e) => setMaxDepth(Number(e.target.value))}
              className="w-24"
            />
            <span className="w-5 text-right font-mono dark:text-slate-300">{maxDepth}</span>
          </label>
        </div>
      </div>

      <div className="flex gap-4" style={{ minHeight: 500 }}>
        {/* Left panel: ranked file list */}
        <div className="w-80 shrink-0 bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 overflow-y-auto" style={{ maxHeight: 600 }}>
          <div className="px-3 py-2 border-b dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              High-Risk Files {totalNodes > 0 && <span className="text-slate-400 dark:text-slate-500">({totalNodes} total)</span>}
            </p>
          </div>
          {overviewLoading && (
            <p className="px-3 py-4 text-sm text-slate-400 dark:text-slate-500">Loading...</p>
          )}
          {overviewError && (
            <p className="px-3 py-4 text-sm text-red-500">{overviewError}</p>
          )}
          {!overviewLoading && !overviewError && overviewFiles.length === 0 && (
            <p className="px-3 py-4 text-sm text-slate-400 dark:text-slate-500">
              No PageRank data. Run <code className="bg-slate-100 dark:bg-slate-700 dark:text-slate-300 px-1 rounded">mma index</code> first.
            </p>
          )}
          {overviewFiles.map((f) => (
            <button
              key={f.path}
              onClick={() => setSelectedFile(f.path)}
              className={`w-full text-left px-3 py-2 border-b dark:border-slate-700 text-sm hover:bg-blue-50 dark:hover:bg-slate-700 transition-colors ${
                selectedFile === f.path
                  ? 'bg-blue-50 dark:bg-slate-700 border-l-2 border-l-blue-500'
                  : ''
              }`}
            >
              <div className="font-medium text-slate-700 dark:text-slate-200 truncate" title={f.path}>
                {lastSegment(f.path)}
              </div>
              <div className="text-xs text-slate-400 dark:text-slate-500 truncate">{f.path}</div>
              <div className="flex gap-3 mt-1 text-xs">
                <span className="text-orange-600 dark:text-orange-400" title="PageRank score">
                  PR: {f.score.toFixed(4)}
                </span>
                <span className="text-blue-600 dark:text-blue-400" title="Transitive dependents count">
                  Reach: {f.reachCount}
                </span>
                <span className="text-slate-400 dark:text-slate-500">#{f.rank}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Right panel: graph or placeholder */}
        <div className="flex-1 bg-white dark:bg-slate-800 rounded-lg shadow-sm border dark:border-slate-700 flex flex-col">
          {!selectedFile && (
            <div className="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm">
              Select a file from the list to view its blast radius graph
            </div>
          )}
          {selectedFile && detailLoading && (
            <div className="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm">
              Computing blast radius...
            </div>
          )}
          {selectedFile && detailError && (
            <div className="flex-1 flex items-center justify-center text-red-500 text-sm">
              {detailError}
            </div>
          )}
          {selectedFile && !detailLoading && !detailError && (
            <>
              <div className="px-3 py-2 border-b dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex items-center justify-between">
                <span className="text-sm text-slate-600 dark:text-slate-300 truncate" title={selectedFile}>
                  {selectedFile}
                </span>
                <span className="text-xs text-slate-400 dark:text-slate-500 shrink-0">
                  {affectedFiles.length} affected files
                </span>
              </div>
              {affectedFiles.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm">
                  No transitive dependents found at depth {maxDepth}
                </div>
              ) : (
                <div className="relative flex-1" style={{ minHeight: 400 }}>
                  <div ref={cyRef} style={{ width: '100%', height: '100%', minHeight: 400 }} />
                  <div className="absolute bottom-4 right-4">
                    <GraphControls cyInstanceRef={cyInstanceRef} />
                  </div>
                </div>
              )}
              <div className="px-3 py-2 border-t dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex gap-4 text-xs text-slate-500 dark:text-slate-400">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-full bg-red-500" /> Root
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-full bg-orange-500" /> Depth 1
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-full bg-yellow-500" /> Depth 2
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-full bg-slate-400" /> Depth 3+
                </span>
                <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
                  Node size = PageRank score
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
