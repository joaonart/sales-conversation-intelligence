import { fmtNum } from "../lib/format";
import type { ChartPoint } from "../lib/dashboard";

const W = 960;
const H = 240;
const L = 40;
const R = 16;
const T = 12;
const B = 28;

/** A line chart (Cloud Monitoring style): light grid, area under the line, a point per day with a tooltip, the value written next to it. Pure SVG, no libraries. */
export function LineChart({ points, title }: { points: ChartPoint[]; title: string }) {
  const n = points.length;
  if (!n) return null;
  const x = (i: number) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = (v: number) => T + (1 - Math.max(0, Math.min(100, v)) / 100) * (H - T - B);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  const every = Math.max(1, Math.ceil(n / 8));
  const valueEvery = Math.max(1, Math.ceil(n / Math.floor((W - L - R) / 36))); // about 36 px per written value
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} class="h-auto w-full">
      {[0, 25, 50, 75, 100].map((g) => (
        <g key={g}>
          <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke="var(--divider)" />
          <text x={L - 8} y={y(g) + 4} text-anchor="end" font-size="11" fill="var(--faint)">{g}</text>
        </g>
      ))}
      <path d={`${line} L${x(n - 1).toFixed(1)} ${y(0)} L${x(0).toFixed(1)} ${y(0)} Z`} fill="var(--primary)" opacity="0.12" />
      <path d={line} fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" />
      {points.map((p, i) => {
        // With many points only every few are labelled so the numbers never overlap.
        const labelled = (i % valueEvery === 0 || i === n - 1) && !(i === n - 1 && i % valueEvery !== 0 && i - Math.floor(i / valueEvery) * valueEvery < valueEvery / 2 && n > 1);
        const below = y(p.value) < T + 16;
        const axis = (i % every === 0 && n - 1 - i >= every) || i === n - 1;
        return (
          <g key={p.tip}>
            <circle cx={x(i)} cy={y(p.value)} r={n > 45 ? 2 : 3.5} fill="var(--surface)" stroke="var(--primary)" stroke-width="2">
              <title>{`${p.tip}: ${fmtNum(p.value)}${p.partial ? " (em andamento)" : ""}`}</title>
            </circle>
            {labelled ? <text x={x(i)} y={below ? y(p.value) + 17 : y(p.value) - 9} text-anchor="middle" font-size="11" font-weight="600" fill="var(--fg)">{fmtNum(p.value)}</text> : null}
            {axis ? <text x={x(i)} y={H - 8} text-anchor="middle" font-size="11" fill="var(--faint)">{p.label.length > 7 ? p.label.slice(0, 5) : p.label}</text> : null}
          </g>
        );
      })}
    </svg>
  );
}
