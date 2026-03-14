// Phase 4: Blast radius visualization — highlights transitive dependents
// Placeholder — full implementation in Phase 4.
import { useParams } from 'react-router-dom';

export default function BlastRadius() {
  const { name } = useParams<{ name: string }>();
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-800">
        Blast Radius — {name}
      </h2>
      <div className="bg-white rounded-lg shadow-sm border p-8 flex items-center justify-center text-slate-400 text-sm h-96">
        Transitive dependent highlighting coming in Phase 4
      </div>
    </div>
  );
}
