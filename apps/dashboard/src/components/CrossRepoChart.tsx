import { useNavigate } from 'react-router-dom';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';

export interface RepoPoint {
  name: string;
  instability: number;
  abstractness: number;
  moduleCount: number;
  painZoneCount: number;
  uselessnessZoneCount: number;
}

function getZoneColor(instability: number, abstractness: number): string {
  const distance = Math.abs(instability + abstractness - 1) / Math.sqrt(2);
  if (distance < 0.3) return '#22c55e';
  if (abstractness > 0.5 && instability < 0.5) return '#eab308';
  return '#ef4444';
}

function pointRadius(moduleCount: number): number {
  // Scale: 1 module = 5px, 100+ modules = 14px
  return Math.max(5, Math.min(14, 5 + Math.sqrt(moduleCount) * 1.2));
}

interface TooltipPayload {
  payload?: RepoPoint;
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
  const distance =
    Math.abs(d.instability + d.abstractness - 1) / Math.sqrt(2);
  return (
    <div className="bg-white border rounded shadow-md p-3 text-xs max-w-xs">
      <p className="font-semibold text-slate-800 truncate mb-1">{d.name}</p>
      <p className="text-slate-600">Avg Instability: {d.instability.toFixed(3)}</p>
      <p className="text-slate-600">Avg Abstractness: {d.abstractness.toFixed(3)}</p>
      <p className="text-slate-600">Distance from main seq: {distance.toFixed(3)}</p>
      <div className="mt-1 pt-1 border-t border-slate-100">
        <p className="text-slate-500">{d.moduleCount} modules</p>
        {d.painZoneCount > 0 && (
          <p className="text-red-600">{d.painZoneCount} in pain zone</p>
        )}
        {d.uselessnessZoneCount > 0 && (
          <p className="text-yellow-600">{d.uselessnessZoneCount} in uselessness zone</p>
        )}
      </div>
    </div>
  );
}

export default function CrossRepoChart({ repos }: { repos: RepoPoint[] }) {
  const navigate = useNavigate();

  const data = repos
    .filter((r) => r.instability != null && r.abstractness != null)
    .map((r) => ({
      ...r,
      fill: getZoneColor(r.instability, r.abstractness),
    }));

  if (data.length === 0) return null;

  function handleClick(point: { name?: string }) {
    if (point?.name) {
      navigate(`/repo/${encodeURIComponent(point.name)}`);
    }
  }

  return (
    <ResponsiveContainer width="100%" height={350}>
      <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis
          dataKey="instability"
          type="number"
          domain={[0, 1]}
          name="Avg Instability"
          label={{
            value: 'Avg Instability',
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
          name="Avg Abstractness"
          label={{
            value: 'Avg Abstractness',
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
            value: 'Main sequence',
            position: 'insideTopRight',
            style: { fontSize: 10, fill: '#94a3b8' },
          }}
        />
        <Tooltip content={<CustomTooltip />} />
        <Scatter
          data={data}
          onClick={handleClick}
          style={{ cursor: 'pointer' }}
          shape={(props: unknown) => {
            const { cx, cy, fill, payload } = props as {
              cx: number;
              cy: number;
              fill: string;
              payload: RepoPoint;
            };
            const r = pointRadius(payload.moduleCount);
            return <circle cx={cx} cy={cy} r={r} fill={fill} fillOpacity={0.8} />;
          }}
        />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
