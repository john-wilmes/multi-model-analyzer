import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchFindings, fetchDependencies } from '../api/client.ts';

interface LogicalLocation {
  fullyQualifiedName?: string;
  name?: string;
  kind?: string;
  properties?: Record<string, unknown>;
}

interface SarifLocation {
  logicalLocations?: LogicalLocation[];
}

interface Finding {
  ruleId?: string;
  level?: string;
  message?: string;
  location?: string;
  locations?: SarifLocation[];
}

interface DepEntry {
  path: string;
  depth: number;
}

interface ModuleMetricsData {
  instability?: number;
  abstractness?: number;
  afferentCoupling?: number;
  efferentCoupling?: number;
}

const BADGE_CLASSES: Record<string, string> = {
  error: 'bg-red-100 text-red-700',
  warning: 'bg-yellow-100 text-yellow-700',
  note: 'bg-blue-100 text-blue-700',
};

function SeverityBadge({ level }: { level?: string }) {
  const cls = BADGE_CLASSES[level ?? ''] ?? 'bg-slate-100 text-slate-600';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {level ?? 'note'}
    </span>
  );
}

export default function ModuleDetail() {
  const { name, '*': modulePath } = useParams<{ name: string; '*': string }>();
  const repo = name ?? '';
  const module = modulePath ?? '';

  const [findings, setFindings] = useState<Finding[]>([]);
  const [outgoing, setOutgoing] = useState<DepEntry[]>([]);
  const [incoming, setIncoming] = useState<DepEntry[]>([]);
  const [metricsData, setMetricsData] = useState<ModuleMetricsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!repo || !module) return;
    Promise.all([
      fetchFindings({ repo, limit: '500' }),
      fetchDependencies(`${repo}:${module}`, 3) as Promise<{ dependencies: DepEntry[]; dependents: DepEntry[] }>,
    ])
      .then(([findingsData, depData]) => {
        // Filter findings to only those affecting this module
        const allFindings = (findingsData.results ?? []) as Finding[];
        const moduleFindings = allFindings.filter((f) => {
          if (!f.locations) return false;
          return f.locations.some((loc) =>
            loc.logicalLocations?.some((ll) => {
              const fqn = ll.fullyQualifiedName ?? '';
              const repoPrefixed = `${repo}/${module}`;
              return (
                fqn === module ||
                fqn.startsWith(module + '/') ||
                fqn === repoPrefixed ||
                fqn.startsWith(repoPrefixed + '/')
              );
            }),
          );
        });
        setFindings(moduleFindings);
        const deps = depData.dependencies ?? [];
        const depnts = depData.dependents ?? [];
        setOutgoing(deps);
        setIncoming(depnts);
        const Ce = deps.length;
        const Ca = depnts.length;
        const instability = Ce + Ca > 0 ? Ce / (Ce + Ca) : 0;
        setMetricsData({ instability, afferentCoupling: Ca, efferentCoupling: Ce });
      })
      .catch((err: unknown) => console.error("Failed to fetch module data:", err))
      .finally(() => setLoading(false));
  }, [repo, module]);

  if (loading) return <p className="text-slate-500">Loading...</p>;

  const distance =
    metricsData?.instability !== undefined &&
    metricsData?.abstractness !== undefined
      ? Math.abs(metricsData.instability + metricsData.abstractness - 1) /
        Math.sqrt(2)
      : undefined;

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/repo/${encodeURIComponent(repo)}`}
          className="text-sm text-blue-600 hover:underline"
        >
          &larr; {repo}
        </Link>
        <h2 className="text-xl font-semibold text-slate-800 mt-1 truncate">
          {module}
        </h2>
      </div>

      {/* Metrics card */}
      {metricsData && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h3 className="text-base font-semibold text-slate-700 mb-3">
            Metrics
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            {[
              {
                label: 'Instability',
                value: metricsData.instability?.toFixed(3),
              },
              {
                label: 'Abstractness',
                value: metricsData.abstractness?.toFixed(3) ?? '-',
              },
              { label: 'Afferent (Ca)', value: metricsData.afferentCoupling },
              { label: 'Efferent (Ce)', value: metricsData.efferentCoupling },
              {
                label: 'Distance',
                value: distance !== undefined ? distance.toFixed(3) : '-',
              },
            ].map(({ label, value }) => (
              <div key={label}>
                <p className="text-xs text-slate-500 mb-0.5">{label}</p>
                <p className="text-lg font-semibold text-slate-800">
                  {value ?? '-'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Findings */}
      <div className="bg-white rounded-lg shadow-sm border p-4">
        <h3 className="text-base font-semibold text-slate-700 mb-3">
          Findings
        </h3>
        {findings.length === 0 ? (
          <p className="text-slate-500 text-sm">No findings for this module.</p>
        ) : (
          <ul className="space-y-2">
            {findings.map((f, i) => (
              <li key={i} className="flex gap-3 items-start text-sm">
                <SeverityBadge level={f.level} />
                <div>
                  <span className="font-mono text-xs text-slate-500 mr-2">
                    {f.ruleId}
                  </span>
                  <span className="text-slate-700">{typeof f.message === 'object' && f.message !== null ? (f.message as { text?: string }).text ?? '-' : f.message ?? '-'}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Dependencies */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h3 className="text-base font-semibold text-slate-700 mb-3">
            Depends on ({outgoing.length})
          </h3>
          {outgoing.length === 0 ? (
            <p className="text-slate-500 text-sm">No outgoing dependencies.</p>
          ) : (
            <ul className="space-y-1">
              {outgoing.map((d, i) => (
                <li key={i} className="text-sm">
                  <Link
                    to={`/repo/${encodeURIComponent(repo)}/module/${encodeURIComponent(d.path)}`}
                    className="text-blue-600 hover:underline font-mono text-xs"
                  >
                    {d.path}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white rounded-lg shadow-sm border p-4">
          <h3 className="text-base font-semibold text-slate-700 mb-3">
            Depended on by ({incoming.length})
          </h3>
          {incoming.length === 0 ? (
            <p className="text-slate-500 text-sm">No incoming dependencies.</p>
          ) : (
            <ul className="space-y-1">
              {incoming.map((d, i) => (
                <li key={i} className="text-sm">
                  <Link
                    to={`/repo/${encodeURIComponent(repo)}/module/${encodeURIComponent(d.path)}`}
                    className="text-blue-600 hover:underline font-mono text-xs"
                  >
                    {d.path}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
