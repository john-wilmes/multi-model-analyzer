import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';

interface AtdiGaugeProps {
  score: number; // 0-100, lower is better
  size?: number; // default 200
}

function getScoreColor(score: number): string {
  if (score <= 20) return '#4ade80'; // green-400
  if (score <= 60) return '#facc15'; // yellow-400
  return '#f87171'; // red-400
}

function getScoreLabel(score: number): string {
  if (score <= 20) return 'Healthy';
  if (score <= 60) return 'Moderate';
  return 'Unhealthy';
}

export default function AtdiGauge({ score, size = 200 }: AtdiGaugeProps) {
  const color = getScoreColor(score);
  const label = getScoreLabel(score);

  // Semicircle: filled arc = score, remainder = 100 - score
  const data = [
    { value: score },
    { value: 100 - score },
  ];

  const outerRadius = size / 2 - 10;
  const innerRadius = outerRadius - 24;

  return (
    <div className="flex flex-col items-center" style={{ width: size, height: size * 0.6 + 40 }}>
      <div style={{ width: size, height: size * 0.6 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="100%"
              startAngle={180}
              endAngle={0}
              innerRadius={innerRadius}
              outerRadius={outerRadius}
              dataKey="value"
              strokeWidth={0}
              isAnimationActive={false}
            >
              <Cell fill={color} />
              <Cell fill="#e2e8f0" />
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-col items-center -mt-2">
        <span className="text-3xl font-bold" style={{ color }}>
          {score}
          <span className="text-base font-normal text-slate-400">/100</span>
        </span>
        <span className="text-xs text-slate-500 mt-0.5">{label}</span>
      </div>
    </div>
  );
}
