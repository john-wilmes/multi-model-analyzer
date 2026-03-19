import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import cytoscape from 'cytoscape';
import cytoscapeDagre from 'cytoscape-dagre';
import {
  fetchBlastRadiusOverview,
  fetchBlastRadius,
  fetchRepos,
} from '../api/client.ts';
import type {
  BlastRadiusOverviewFile,
  BlastRadiusAffectedFile,
} from '../api/client.ts';

cytoscapeDagre(cytoscape);

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

function viaColor(via: string): string {
  if (via === 'imports') return '#3b82f6';
  if (via === 'calls') return '#8b5cf6';
  return '#10b981'; // both
}

export default function BlastRadius() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();

  const [repos, setRepos] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState(name ?? '');
  const [maxDepth, setMaxDepth] = useState(5);

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
        if (!selectedRepo && d.repos.length > 0) setSelectedRepo(d.repos[0]!);
      })
      .catch(() => setRepos([]));
  }, []);

  // Update URL when repo changes
  useEffect(() => {
    if (selectedRepo && selectedRepo !== name) {
      navigate(`/blast-radius/${encodeURIComponent(selectedRepo)}`, { replace: true });
    }
  }, [selectedRepo, name, navigate]);

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

    // Build edges: connect each affected file to its "parent" at depth - 1
    // Since we don't have explicit parent info, connect by depth layers
    const byDepth = new Map<number, string[]>();
    for (const [id, info] of nodeMap) {
      const arr = byDepth.get(info.depth) ?? [];
      arr.push(id);
      byDepth.set(info.depth, arr);
    }

    const cyEdges: Array<{ data: { id: string; source: string; target: string; via: string } }> = [];
    let edgeIdx = 0;

    // For each affected file, create an edge from the file to one at depth-1
    // Use a simple heuristic: connect to the nearest parent by depth
    for (const f of affectedFiles) {
      const parents = byDepth.get(f.depth - 1) ?? [];
      if (parents.length > 0) {
        // Pick the first parent (simplified — real graph would need actual edge data)
        cyEdges.push({
          data: {
            id: `e${edgeIdx++}`,
            source: parents[0]!,
            target: f.path,
            via: f.via,
          },
        });
      }
    }

    const cy = cytoscape({
      container: cyRef.current,
      elements: [...nodes, ...cyEdges],
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
          selector: 'edge',
          style: {
            width: 1.5,
            'line-color': (ele: cytoscape.EdgeSingular) => viaColor(ele.data('via') as string),
            'target-arrow-color': (ele: cytoscape.EdgeSingular) => viaColor(ele.data('via') as string),
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
          } as cytoscape.Css.Edge,
        },
        {
          selector: 'node.highlighted',
          style: {
            'border-width': 3,
            'border-color': '#1d4ed8',
          } as cytoscape.Css.Node,
        },
        {
          selector: 'edge.highlighted',
          style: { width: 3 } as cytoscape.Css.Edge,
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
        nodeSep: 50,
        rankSep: 70,
      } as cytoscape.LayoutOptions,
      minZoom: 0.2,
      maxZoom: 3,
    });

    // Hover: highlight connected
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
        <h2 className="text-xl font-semibold text-slate-800">Blast Radius</h2>
        <div className="flex items-center gap-3">
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="text-sm border border-slate-300 rounded px-2 py-1 bg-white text-slate-700"
          >
            {repos.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Depth:
            <input
              type="range"
              min={1}
              max={10}
              value={maxDepth}
              onChange={(e) => setMaxDepth(Number(e.target.value))}
              className="w-24"
            />
            <span className="w-5 text-right font-mono">{maxDepth}</span>
          </label>
        </div>
      </div>

      <div className="flex gap-4" style={{ minHeight: 500 }}>
        {/* Left panel: ranked file list */}
        <div className="w-80 shrink-0 bg-white rounded-lg shadow-sm border overflow-y-auto" style={{ maxHeight: 600 }}>
          <div className="px-3 py-2 border-b bg-slate-50">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              High-Risk Files {totalNodes > 0 && <span className="text-slate-400">({totalNodes} total)</span>}
            </p>
          </div>
          {overviewLoading && (
            <p className="px-3 py-4 text-sm text-slate-400">Loading...</p>
          )}
          {overviewError && (
            <p className="px-3 py-4 text-sm text-red-500">{overviewError}</p>
          )}
          {!overviewLoading && !overviewError && overviewFiles.length === 0 && (
            <p className="px-3 py-4 text-sm text-slate-400">
              No PageRank data. Run <code className="bg-slate-100 px-1 rounded">mma index</code> first.
            </p>
          )}
          {overviewFiles.map((f) => (
            <button
              key={f.path}
              onClick={() => setSelectedFile(f.path)}
              className={`w-full text-left px-3 py-2 border-b text-sm hover:bg-blue-50 transition-colors ${
                selectedFile === f.path ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''
              }`}
            >
              <div className="font-medium text-slate-700 truncate" title={f.path}>
                {lastSegment(f.path)}
              </div>
              <div className="text-xs text-slate-400 truncate">{f.path}</div>
              <div className="flex gap-3 mt-1 text-xs">
                <span className="text-orange-600" title="PageRank score">
                  PR: {f.score.toFixed(4)}
                </span>
                <span className="text-blue-600" title="Transitive dependents count">
                  Reach: {f.reachCount}
                </span>
                <span className="text-slate-400">#{f.rank}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Right panel: graph or placeholder */}
        <div className="flex-1 bg-white rounded-lg shadow-sm border flex flex-col">
          {!selectedFile && (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
              Select a file from the list to view its blast radius graph
            </div>
          )}
          {selectedFile && detailLoading && (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
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
              <div className="px-3 py-2 border-b bg-slate-50 flex items-center justify-between">
                <span className="text-sm text-slate-600 truncate" title={selectedFile}>
                  {selectedFile}
                </span>
                <span className="text-xs text-slate-400 shrink-0">
                  {affectedFiles.length} affected files
                </span>
              </div>
              {affectedFiles.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
                  No transitive dependents found at depth {maxDepth}
                </div>
              ) : (
                <div ref={cyRef} style={{ width: '100%', flex: 1, minHeight: 400 }} />
              )}
              <div className="px-3 py-2 border-t bg-slate-50 flex gap-4 text-xs text-slate-500">
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
                <span className="ml-auto flex items-center gap-2">
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-4 h-0.5 bg-blue-500" /> imports
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-4 h-0.5 bg-purple-500" /> calls
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-4 h-0.5 bg-emerald-500" /> both
                  </span>
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
