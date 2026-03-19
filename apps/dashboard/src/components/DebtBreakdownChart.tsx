import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

export interface DebtCategory {
  category: string;
  debtMinutes: number;
  debtHours: number;
  findingCount: number;
}

interface DebtBreakdownChartProps {
  categories: DebtCategory[];
}

interface TooltipPayload {
  payload?: DebtCategory;
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
  return (
    <div className="bg-white border rounded shadow-md p-3 text-xs">
      <p className="font-semibold text-slate-800 mb-1">{d.category}</p>
      <p className="text-slate-600">{d.debtHours}h remediation</p>
      <p className="text-slate-500">{d.findingCount} findings</p>
    </div>
  );
}

export default function DebtBreakdownChart({ categories }: DebtBreakdownChartProps) {
  const sorted = [...categories]
    .sort((a, b) => b.debtMinutes - a.debtMinutes)
    .slice(0, 8);

  if (sorted.length === 0) return null;

  const maxHours = Math.max(...sorted.map((c) => c.debtHours), 1);

  return (
    <ResponsiveContainer width="100%" height={Math.max(180, sorted.length * 36)}>
      <BarChart
        data={sorted}
        layout="vertical"
        margin={{ top: 4, right: 48, bottom: 4, left: 100 }}
      >
        <XAxis
          type="number"
          domain={[0, maxHours]}
          tick={{ fontSize: 11, fill: '#64748b' }}
          tickFormatter={(v: number) => `${v}h`}
        />
        <YAxis
          type="category"
          dataKey="category"
          width={96}
          tick={{ fontSize: 11, fill: '#475569' }}
        />
        <Tooltip content={<CustomTooltip />} />
        <Bar dataKey="debtHours" radius={[0, 3, 3, 0]} isAnimationActive={false}>
          {sorted.map((entry) => (
            <Cell key={entry.category} fill="#3b82f6" />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
