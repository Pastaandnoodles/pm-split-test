import { useEffect, useState } from 'react';
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartOptions,
} from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';
import type { Group } from '../domain/types';
import { GROUP_LABEL } from '../domain/printers';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Tooltip, Legend);

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

export const groupColor = (t: Theme, g: Group) => (g === 'control' ? t.control : t.maint);

function baseOptions(t: Theme, percent: boolean): ChartOptions<'bar' | 'line'> {
  const tick = percent ? (v: string | number) => `${Math.round(Number(v) * 100)}%` : undefined;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { position: 'top', align: 'start', labels: { color: t.text2, usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 10, boxHeight: 10 } },
      tooltip: {
        callbacks: percent ? { label: (c) => `${c.dataset.label}: ${(Number(c.raw) * 100).toFixed(1)}%` } : undefined,
      },
    },
    scales: {
      x: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.muted } },
      y: { grid: { color: t.grid }, border: { display: false }, ticks: { color: t.muted, callback: tick } },
    },
  };
}

/** One line per group across cycles. Values are 0..1 when percent is set. */
export function GroupLineChart({ labels, series, percent = true, label }: { labels: string[]; series: Record<Group, (number | null)[]>; percent?: boolean; label: string }) {
  const t = useTheme();
  const opts = baseOptions(t, percent) as ChartOptions<'line'>;
  opts.interaction = { mode: 'index', intersect: false };
  return (
    <div className="chart-box" role="img" aria-label={label}>
      <Line
        options={opts}
        data={{
          labels,
          datasets: (['control', 'maintenance'] as Group[]).map((g) => ({
            label: GROUP_LABEL[g],
            data: series[g],
            borderColor: groupColor(t, g),
            backgroundColor: groupColor(t, g),
            borderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBorderColor: t.surface,
            pointBorderWidth: 2,
            spanGaps: true,
          })),
        }}
      />
    </div>
  );
}

/** Grouped bars: one bar per group for each category. */
export function GroupBarChart({ labels, series, horizontal = false, label, height }: { labels: string[]; series: Record<Group, number[]>; horizontal?: boolean; label: string; height?: number }) {
  const t = useTheme();
  const opts = baseOptions(t, false) as ChartOptions<'bar'>;
  if (horizontal) {
    opts.indexAxis = 'y';
    opts.scales = {
      x: { grid: { color: t.grid }, border: { display: false }, ticks: { color: t.muted, precision: 0 } },
      y: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.text2 } },
    };
  } else {
    opts.scales!.y = { ...opts.scales!.y, ticks: { color: t.muted, precision: 0 } };
  }
  return (
    <div className="chart-box" style={height ? { height } : undefined} role="img" aria-label={label}>
      <Bar
        options={opts}
        data={{
          labels,
          datasets: (['control', 'maintenance'] as Group[]).map((g) => ({
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
