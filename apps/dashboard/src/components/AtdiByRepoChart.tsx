import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts';

export interface RepoAtdiScore {
  repo: string;
  score: number;
}

interface AtdiByRepoChartProps {
  repos: RepoAtdiScore[];
}

function getScoreColor(score: number): string {
  if (score <= 20) return '#4ade80'; // green-400
  if (score <= 60) return '#facc15'; // yellow-400
  return '#f87171'; // red-400
}

// Truncate long repo names for the X axis tick
function shortName(repo: string): string {
  if (repo.length <= 16) return repo;
  return repo.slice(0, 14) + '…';
}

interface TooltipPayload {
  payload?: RepoAtdiScore;
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
  const label =
    d.score <= 20 ? 'Healthy' : d.score <= 60 ? 'Moderate' : 'Unhealthy';
  return (
    <div className="bg-white border rounded shadow-md p-3 text-xs">
      <p className="font-semibold text-slate-800 mb-1 max-w-[200px] break-all">
        {d.repo}
      </p>
      <p className="text-slate-600">
        ATDI: <span className="font-medium">{d.score}</span>/100
      </p>
      <p className="text-slate-500">{label}</p>
    </div>
  );
}

export default function AtdiByRepoChart({ repos }: AtdiByRepoChartProps) {
  const sorted = [...repos].sort((a, b) => a.score - b.score);

  if (sorted.length === 0) return null;

  const chartData = sorted.map((r) => ({ ...r, short: shortName(r.repo) }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart
        data={chartData}
        margin={{ top: 8, right: 16, bottom: 56, left: 16 }}
      >
        <XAxis
          dataKey="short"
          tick={{ fontSize: 10, fill: '#64748b' }}
          angle={-40}
          textAnchor="end"
          interval={0}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fontSize: 11, fill: '#64748b' }}
          width={32}
        />
        <ReferenceLine
          y={20}
          stroke="#4ade80"
          strokeDasharray="4 3"
          strokeWidth={1}
          label={{ value: '20', position: 'right', fontSize: 9, fill: '#4ade80' }}
        />
        <ReferenceLine
          y={60}
          stroke="#facc15"
          strokeDasharray="4 3"
          strokeWidth={1}
          label={{ value: '60', position: 'right', fontSize: 9, fill: '#facc15' }}
        />
        <Tooltip content={<CustomTooltip />} />
        <Bar dataKey="score" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {chartData.map((entry) => (
            <Cell key={entry.repo} fill={getScoreColor(entry.score)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
