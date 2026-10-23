import { useEffect, useState, type ReactNode } from 'react';
import { BarElement, CategoryScale, Chart as ChartJS, Legend, LinearScale, Tooltip, type ChartDataset, type ChartOptions } from 'chart.js';
import { Bar } from 'react-chartjs-2';
import type { Group } from '../domain/types';
import type { YieldShare } from '../domain/analysis';
import { GROUP_LABEL } from '../domain/printers';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

interface Theme {
  control: string;
  maint: string;
  surface: string;
  text2: string;
  muted: string;
  grid: string;
  axis: string;
}

function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return { control: v('--control'), maint: v('--maint'), surface: v('--surface'), text2: v('--text-2'), muted: v('--muted'), grid: v('--grid'), axis: v('--axis') };
}

/** Re-reads the CSS tokens when the OS switches light/dark. */
export function useTheme(): Theme {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setTheme(readTheme());
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return theme;
}

const GROUPS: Group[] = ['control', 'maintenance'];
export const groupColor = (t: Theme, g: Group) => (g === 'control' ? t.control : t.maint);

/** Hex color at an opacity, for the translucent yield segments. */
function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? [...h].map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const pct = (v: unknown) => `${(Number(v) * 100).toFixed(1)}%`;

function percentOptions(t: Theme, stacked: boolean): ChartOptions<'bar'> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false }, // an HTML legend sits above both panels so their scales line up
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${pct(c.raw)}` } },
    },
    scales: {
      x: { stacked, grid: { display: false }, border: { color: t.axis }, ticks: { color: t.text2 } },
      y: { stacked, min: 0, max: 1, grid: { color: t.grid }, border: { display: false }, ticks: { color: t.muted, stepSize: 0.25, callback: (v) => pct(v).replace('.0', '') } },
    },
  };
}

/** Averages on the left, one pair of bars per cycle on the right, on the same 0–100% scale. */
function AvgAndCycles({ label, left, right }: { label: string; left: ReactNode; right: ReactNode }) {
  return (
    <div className="avg-cycles" role="img" aria-label={label}>
      <div className="chart-box">{left}</div>
      <div className="chart-box">{right}</div>
    </div>
  );
}

/** Pass rate (share of plates that passed): all-cycles average beside each cycle. */
export function PassRateBars({ average, cycles }: { average: Record<Group, number | null>; cycles: { label: string; values: Record<Group, number | null> }[] }) {
  const t = useTheme();
  const ds = (g: Group, data: (number | null)[], thick: number): ChartDataset<'bar', (number | null)[]> => ({
    label: GROUP_LABEL[g],
    data,
    backgroundColor: groupColor(t, g),
    maxBarThickness: thick,
    borderRadius: 4,
    borderSkipped: 'start',
    categoryPercentage: 0.7,
    barPercentage: 0.9,
  });
  return (
    <>
      <div className="legend" style={{ marginBottom: 0 }}>
        <span className="gtag g-control">Control</span>
        <span className="gtag g-maintenance">Maintenance</span>
      </div>
      <AvgAndCycles
        label="Plate pass rate for each group: all-cycles average and each cycle"
        left={<Bar options={percentOptions(t, false)} data={{ labels: ['All cycles average'], datasets: GROUPS.map((g) => ds(g, [average[g]], 56)) }} />}
        right={<Bar options={percentOptions(t, false)} data={{ labels: cycles.map((c) => c.label), datasets: GROUPS.map((g) => ds(g, cycles.map((c) => c.values[g]), 24)) }} />}
      />
    </>
  );
}

const SEGMENTS: { key: keyof YieldShare; label: string; opacity: number }[] = [
  { key: 'good', label: 'Good', opacity: 1 },
  { key: 'seconds', label: 'Seconds', opacity: 0.4 },
  { key: 'scrap', label: 'Scrap', opacity: 0.24 },
  { key: 'missing', label: 'Missing', opacity: 0.1 },
];

/** Stacked bars: good parts solid, seconds / scrap / missing increasingly translucent, in each group's color. */
export function YieldStackBars({ average, cycles }: { average: Record<Group, YieldShare | null>; cycles: { label: string; shares: Record<Group, YieldShare | null> }[] }) {
  const t = useTheme();
  const datasets = (rows: Record<Group, YieldShare | null>[], thick: number): ChartDataset<'bar', (number | null)[]>[] =>
    GROUPS.flatMap((g) =>
      SEGMENTS.map((s) => ({
        label: `${GROUP_LABEL[g]} · ${s.label}`,
        data: rows.map((r) => (r[g] ? r[g]![s.key] : null)),
        stack: g,
        backgroundColor: alpha(groupColor(t, g), s.opacity),
        borderColor: t.surface,
        borderWidth: { top: 2, bottom: 0, left: 0, right: 0 },
        borderSkipped: 'start' as const,
        maxBarThickness: thick,
        categoryPercentage: 0.7,
        barPercentage: 0.9,
      })),
    );
  return (
    <>
      <div className="legend" style={{ marginBottom: 0 }}>
        <span className="gtag g-control">Control</span>
        <span className="gtag g-maintenance">Maintenance</span>
        {SEGMENTS.map((s) => (
          <span key={s.key} className="seg-key">
            <span style={{ opacity: s.opacity }} />
            {s.label}
          </span>
        ))}
      </div>
      <AvgAndCycles
        label="Yield breakdown for each group: good, seconds, scrap and missing as a share of expected parts, all-cycles average and each cycle"
        left={<Bar options={percentOptions(t, true)} data={{ labels: ['All cycles average'], datasets: datasets([average], 56) }} />}
        right={<Bar options={percentOptions(t, true)} data={{ labels: cycles.map((c) => c.label), datasets: datasets(cycles.map((c) => c.shares), 24) }} />}
      />
    </>
  );
}

/** Grouped bars: one bar per group for each category. */
export function GroupBarChart({ labels, series, horizontal = false, label, height }: { labels: string[]; series: Record<Group, number[]>; horizontal?: boolean; label: string; height?: number }) {
  const t = useTheme();
  const opts: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    indexAxis: horizontal ? 'y' : 'x',
    plugins: { legend: { position: 'top', align: 'start', labels: { color: t.text2, usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 10, boxHeight: 10 } } },
    scales: horizontal
      ? {
          x: { grid: { color: t.grid }, border: { display: false }, ticks: { color: t.muted, precision: 0 } },
          y: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.text2 } },
        }
      : {
          x: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.muted } },
          y: { grid: { color: t.grid }, border: { display: false }, ticks: { color: t.muted, precision: 0 } },
        },
  };
  return (
    <div className="chart-box" style={height ? { height } : undefined} role="img" aria-label={label}>
      <Bar
        options={opts}
        data={{
          labels,
          datasets: GROUPS.map((g) => ({
            label: GROUP_LABEL[g],
            data: series[g],
            backgroundColor: groupColor(t, g),
            maxBarThickness: 24,
            borderRadius: 4,
            borderSkipped: 'start',
            borderColor: t.surface,
            borderWidth: { top: 0, bottom: 0, left: horizontal ? 0 : 1, right: horizontal ? 0 : 1 },
            categoryPercentage: 0.7,
            barPercentage: 0.9,
          })),
        }}
      />
    </div>
  );
}
