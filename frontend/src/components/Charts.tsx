/**
 * Hand-rolled SVG micro-charts — matches the dashboard's flat aesthetic and
 * keeps the bundle dependency-free.
 */
import { useState } from 'react';

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

// ── Metric line chart: single series, date x-axis, hover tooltip ─────────────

export function MetricChart({ points, color = 'var(--accent, #7c6cf5)', format = (n: number) => String(Math.round(n)), height = 200, label = 'Metric trend' }: {
  points: Array<{ date: string; value: number }>;
  color?: string;
  format?: (n: number) => string;
  height?: number;
  label?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, padL = 44, padR = 12, padT = 12, padB = 26;
  if (points.length < 2) {
    return <div className="empty-note" style={{ height }}>Not enough data to plot yet.</div>;
  }
  const max = Math.max(...points.map(p => p.value), 1);
  const min = Math.min(...points.map(p => p.value), 0);
  const span = max - min || 1;
  const iw = W - padL - padR, ih = height - padT - padB;
  const x = (i: number) => padL + (i / (points.length - 1)) * iw;
  const y = (v: number) => padT + ih - ((v - min) / span) * ih;
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(padT + ih).toFixed(1)} L${padL},${(padT + ih).toFixed(1)} Z`;
  const ticks = [min, min + span / 2, max];
  const everyN = Math.ceil(points.length / 6);

  return (
    <div className="metric-chart-wrap" style={{ position: 'relative' }}>
      <svg role="img" aria-label={`${label}. ${points.length} points from ${points[0].date} at ${format(points[0].value)} to ${points.at(-1)!.date} at ${format(points.at(-1)!.value)}.`} viewBox={`0 0 ${W} ${height}`} width="100%" height={height} preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={e => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - padL) / iw) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, i)));
        }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize={12} fill="var(--text-dim)">{format(t)}</text>
          </g>
        ))}
        {points.map((p, i) => i % everyN === 0 && (
          <text key={i} x={x(i)} y={height - 8} textAnchor="middle" fontSize={12} fill="var(--text-dim)">{p.date.slice(5)}</text>
        ))}
        <path d={area} fill={color} opacity={0.12} />
        <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + ih} stroke={color} strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(points[hover].value)} r={3.5} fill={color} />
          </>
        )}
      </svg>
      {hover !== null && (
        <div className="metric-chart-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <strong>{format(points[hover].value)}</strong>
          <span>{points[hover].date}</span>
        </div>
      )}
    </div>
  );
}
