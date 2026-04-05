import { useEffect, useState } from 'react';
import { fetchRepos, fetchConstraints, validateConstraints, type ConfigDomain, type ValidationResultData } from '../api/client.ts';

const DOMAINS: { value: ConfigDomain; label: string }[] = [
  { value: 'credentials', label: 'Credentials' },
  { value: 'integrator-settings', label: 'Integrator Settings' },
  { value: 'account-settings', label: 'Account Settings' },
];

export default function ConfigValidatorView() {
  const [repos, setRepos] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [domain, setDomain] = useState<ConfigDomain>('credentials');
  const [integratorTypes, setIntegratorTypes] = useState<string[]>([]);
  const [selectedType, setSelectedType] = useState<string>('');
  const [configText, setConfigText] = useState('{\n  \n}');
  const [result, setResult] = useState<ValidationResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    fetchRepos({ indexed: true })
      .then(({ repos: repoList }) => {
        setRepos(repoList);
        if (repoList.length > 0) setSelectedRepo(repoList[0]);
      })
      .catch(() => setRepos([]));
  }, []);

  useEffect(() => {
    if (!selectedRepo) return;
    setIntegratorTypes([]);
    setSelectedType('');
    fetchConstraints(domain, selectedRepo)
      .then(({ constraintSets }) => {
        const types = constraintSets.map((s) => s.integratorType).sort();
        setIntegratorTypes(types);
        if (types.length > 0) setSelectedType(types[0]);
      })
      .catch(() => setIntegratorTypes([]));
  }, [selectedRepo, domain]);

  async function handleValidate() {
    setError(null);
    setResult(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(configText) as Record<string, unknown>;
    } catch {
      setError('Invalid JSON — fix the config text before validating.');
      return;
    }
    if (!selectedType) {
      setError('Select an integrator type.');
      return;
    }
    setRunning(true);
    try {
      const r = await validateConstraints(parsed, selectedType, domain, selectedRepo || undefined);
      setResult(r);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-100">Config Validator</h1>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Repo</label>
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="w-full bg-slate-700 text-slate-200 rounded px-3 py-2 text-sm border border-slate-600"
          >
            {repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Domain</label>
          <select
            value={domain}
            onChange={(e) => setDomain(e.target.value as ConfigDomain)}
            className="w-full bg-slate-700 text-slate-200 rounded px-3 py-2 text-sm border border-slate-600"
          >
            {DOMAINS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Integrator Type</label>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            className="w-full bg-slate-700 text-slate-200 rounded px-3 py-2 text-sm border border-slate-600"
          >
            {integratorTypes.length === 0 && <option value="">— none —</option>}
            {integratorTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-xs text-slate-400 mb-1">Config JSON</label>
        <textarea
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          rows={12}
          className="w-full bg-slate-900 text-slate-200 rounded px-4 py-3 text-sm font-mono border border-slate-600 focus:border-blue-500 focus:outline-none resize-y"
          spellCheck={false}
        />
      </div>

      <button
        onClick={() => { void handleValidate(); }}
        disabled={running || !selectedType}
        className="px-5 py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
      >
        {running ? 'Validating…' : 'Validate'}
      </button>

      {error && (
        <div className="bg-red-900/20 border border-red-700 rounded-lg p-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-4">
          <div className={`rounded-lg p-4 flex items-center gap-3 ${result.valid ? 'bg-emerald-900/20 border border-emerald-700' : 'bg-red-900/20 border border-red-700'}`}>
            <span className={`text-lg font-bold ${result.valid ? 'text-emerald-400' : 'text-red-400'}`}>
              {result.valid ? 'Valid' : 'Invalid'}
            </span>
            {result.coverage && (
              <span className="text-sm text-slate-400 ml-auto">
                Coverage: {result.coverage.resolvedAccesses}/{result.coverage.totalAccesses}
              </span>
            )}
          </div>

          {result.violations.length > 0 && (
            <div className="bg-slate-800 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-700 text-sm font-semibold text-slate-300">
                Violations ({result.violations.length})
              </div>
              <ul className="divide-y divide-slate-700/50">
                {result.violations.map((v, i) => (
                  <li key={i} className="px-4 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-red-300">{v.field}</span>
                      <span className="text-xs text-slate-500 bg-slate-700 px-1.5 py-0.5 rounded">{v.kind}</span>
                    </div>
                    <div className="text-xs text-slate-400 mt-1">{v.detail}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.nearestValid && (
            <div className="bg-slate-800 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-700 text-sm font-semibold text-slate-300">
                Nearest Valid Config ({result.nearestValid.changes.length} change{result.nearestValid.changes.length !== 1 ? 's' : ''})
              </div>
              <ul className="divide-y divide-slate-700/50">
                {result.nearestValid.changes.map((c, i) => (
                  <li key={i} className="px-4 py-3 text-sm flex items-start gap-3">
                    <span className="text-xs bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded shrink-0">{c.action}</span>
                    <span className="font-mono text-xs text-slate-200">{c.field}</span>
                    {c.suggestion !== undefined && (
                      <span className="font-mono text-xs text-slate-400 ml-auto">{String(c.suggestion)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
