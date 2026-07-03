/**
 * Hand-rolled SVG micro-charts — matches the dashboard's flat aesthetic and
 * keeps the bundle dependency-free.
 */

export function Sparkline({ points, width = 120, height = 32, stroke = 'var(--ok)' }: {
  points: number[];
  width?: number;
  height?: number;
  stroke?: string;
}) {
  if (points.length < 2) {
    return <svg width={width} height={height} aria-hidden="true"><line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="var(--border)" strokeDasharray="3 3" /></svg>;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const path = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`)
    .join(' ');
  const last = points[points.length - 1];
  const lastY = height - 3 - ((last - min) / span) * (height - 6);
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={width} cy={lastY} r={2.5} fill={stroke} />
    </svg>
  );
}

/** Horizontal funnel: sitemap → submitted → indexed, proportional bars. */
export function FunnelBar({ stages }: { stages: Array<{ label: string; value: number; color: string }> }) {
  const max = Math.max(...stages.map(s => s.value), 1);
  return (
    <div className="funnel">
      {stages.map(s => (
        <div key={s.label} className="funnel-row">
          <span className="funnel-label">{s.label}</span>
          <div className="funnel-track">
            <div className="funnel-fill" style={{ width: `${Math.max((s.value / max) * 100, s.value > 0 ? 2 : 0)}%`, background: s.color }} />
          </div>
          <span className="funnel-value">{s.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

export function StatCard({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'ok' | 'warn' | 'error' }) {
  return (
    <div className="stat-card">
      <div className="stat-card-value" style={tone ? { color: `var(--${tone})` } : undefined}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
      <div className="stat-card-label">{label}</div>
      {sub && <div className="stat-card-sub">{sub}</div>}
    </div>
  );
}
