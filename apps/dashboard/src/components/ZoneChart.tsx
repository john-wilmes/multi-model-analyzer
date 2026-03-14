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

export interface ModuleMetrics {
  name: string;
  instability: number;
  abstractness: number;
  repo?: string;
}

interface ZoneChartProps {
  repo: string;
  metrics: ModuleMetrics[];
}

function getZoneColor(instability: number, abstractness: number): string {
  const distance = Math.abs(instability + abstractness - 1) / Math.sqrt(2);
  if (distance < 0.3) return '#22c55e'; // green - balanced
  if (abstractness > 0.5 && instability < 0.5) return '#eab308'; // yellow - uselessness
  return '#ef4444'; // red - pain zone
}

interface TooltipPayload {
  payload?: ModuleMetrics;
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
      <p className="text-slate-600">Instability: {d.instability.toFixed(3)}</p>
      <p className="text-slate-600">
        Abstractness: {d.abstractness.toFixed(3)}
      </p>
      <p className="text-slate-600">
        Distance from main seq: {distance.toFixed(3)}
      </p>
    </div>
  );
}

export default function ZoneChart({ repo, metrics }: ZoneChartProps) {
  const navigate = useNavigate();

  const data = metrics.map((m) => ({
    ...m,
    fill: getZoneColor(m.instability, m.abstractness),
  }));

  function handleClick(point: { name?: string }) {
    if (point?.name) {
      navigate(
        `/repo/${encodeURIComponent(repo)}/module/${encodeURIComponent(point.name)}`,
      );
    }
  }

  return (
    <ResponsiveContainer width="100%" height={400}>
      <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
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
        {/* Main sequence diagonal: from (0,1) to (1,0) */}
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
          shape={(props: Record<string, unknown>) => {
            const { cx, cy, fill } = props as {
              cx: number;
              cy: number;
              fill: string;
            };
            return <circle cx={cx} cy={cy} r={5} fill={fill} fillOpacity={0.8} />;
          }}
        />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
