// Phase 4: Interactive dependency graph using Cytoscape.js + cytoscape-dagre
// Placeholder — full implementation in Phase 4.
import { useParams } from 'react-router-dom';

export default function DependencyGraph() {
  const { name } = useParams<{ name: string }>();
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-800">
        Dependency Graph — {name}
      </h2>
      <div className="bg-white rounded-lg shadow-sm border p-8 flex items-center justify-center text-slate-400 text-sm h-96">
        Interactive graph coming in Phase 4 (Cytoscape.js + dagre layout)
      </div>
    </div>
  );
}
