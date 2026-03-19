import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
} from 'recharts';
import type { ModuleMetric } from '../api/client.ts';

function getZoneColor(zone: string): string {
  switch (zone) {
    case 'pain': return '#ef4444';
    case 'uselessness': return '#eab308';
    case 'balanced': return '#3b82f6';
    default: return '#22c55e';
  }
}

function pointRadius(ca: number): number {
  // Scale: 0 dependents = 4px, 50+ dependents = 12px
  return Math.max(4, Math.min(12, 4 + Math.sqrt(ca) * 1.1));
}

interface TooltipPayload {
  payload?: ModuleMetric;
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  if (!d) return null;
  const shortModule = d.module.length > 50 ? '…' + d.module.slice(-50) : d.module;
  return (
    <div className="bg-white border rounded shadow-md p-3 text-xs max-w-xs">
      <p className="font-semibold text-slate-800 truncate mb-1" title={d.module}>
        {shortModule}
      </p>
      <p className="text-slate-500 truncate mb-1">{d.repo}</p>
      <p className="text-slate-600">Instability: {d.instability.toFixed(3)}</p>
      <p className="text-slate-600">Abstractness: {d.abstractness.toFixed(3)}</p>
      <p className="text-slate-600">Distance: {d.distance.toFixed(3)}</p>
      <div className="mt-1 pt-1 border-t border-slate-100">
        <p className="text-slate-500">Ca (afferent): {d.ca}</p>
        <p className="text-slate-500">Ce (efferent): {d.ce}</p>
        <p
          className={
            d.zone === 'pain'
              ? 'text-red-600'
              : d.zone === 'uselessness'
              ? 'text-yellow-600'
              : d.zone === 'balanced'
              ? 'text-blue-600'
              : 'text-green-600'
          }
        >
          Zone: {d.zone}
        </p>
      </div>
    </div>
  );
}

export default function MainSequenceChart({ modules }: { modules: ModuleMetric[] }) {
  // Take top 500 by distance (furthest from main sequence first)
  const data = modules
    .filter((m) => m.instability != null && m.abstractness != null)
    .sort((a, b) => b.distance - a.distance)
    .slice(0, 500)
    .map((m) => ({
      ...m,
      fill: getZoneColor(m.zone),
    }));

  if (data.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={400}>
      <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        {/* Pain zone: low instability, low abstractness (rigid, concrete) */}
        <ReferenceArea
          x1={0}
          x2={0.3}
          y1={0}
          y2={0.3}
          fill="#ef4444"
          fillOpacity={0.06}
          label={{
            value: 'Pain',
            position: 'insideBottomLeft',
            style: { fontSize: 10, fill: '#ef4444' },
          }}
        />
        {/* Uselessness zone: high instability, high abstractness (unstable, abstract) */}
        <ReferenceArea
          x1={0.7}
          x2={1}
          y1={0.7}
          y2={1}
          fill="#eab308"
          fillOpacity={0.06}
          label={{
            value: 'Uselessness',
            position: 'insideTopRight',
            style: { fontSize: 10, fill: '#eab308' },
          }}
        />
        <XAxis
          dataKey="instability"
          type="number"
          domain={[0, 1]}
          name="Instability"
          label={{
            value: 'Instability',
            position: 'insideBottom',
            offset: -10,
            style: { fontSize: 12, fill: '#64748b' },
          }}
          tick={{ fontSize: 11, fill: '#64748b' }}
        />
        <YAxis
          dataKey="abstractness"
          type="number"
          domain={[0, 1]}
          name="Abstractness"
          label={{
            value: 'Abstractness',
            angle: -90,
            position: 'insideLeft',
            offset: 10,
            style: { fontSize: 12, fill: '#64748b' },
          }}
          tick={{ fontSize: 11, fill: '#64748b' }}
        />
        <ReferenceLine
          segment={[
            { x: 0, y: 1 },
            { x: 1, y: 0 },
          ]}
          stroke="#94a3b8"
          strokeDasharray="4 4"
          label={{
            value: 'Main Sequence',
            position: 'insideTopRight',
            style: { fontSize: 10, fill: '#94a3b8' },
          }}
        />
        <Tooltip content={<CustomTooltip />} />
        <Scatter
          data={data}
          shape={(props: unknown) => {
            const { cx, cy, fill, payload } = props as {
              cx: number;
              cy: number;
              fill: string;
              payload: ModuleMetric;
            };
            const r = pointRadius(payload.ca);
            return <circle cx={cx} cy={cy} r={r} fill={fill} fillOpacity={0.75} />;
          }}
        />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
