import { useState } from 'react';
import { useDataset, openCycle } from '../db/useDataset';
import type { Dataset, Group } from '../domain/types';
import { GROUP_LABEL } from '../domain/printers';
import { MapView } from './MapView';
import { CyclesView } from './CyclesView';
import { SetupView } from './SetupView';
import { AnalysisView } from './AnalysisView';
import { DataView } from './DataView';

const TABS = [
  { id: 'map', label: 'Map' },
  { id: 'cycles', label: 'Cycles' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'setup', label: 'Setup' },
  { id: 'data', label: 'Data' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function loadTab(): TabId {
  try {
    const t = localStorage.getItem('tab');
    if (TABS.some((x) => x.id === t)) return t as TabId;
  } catch {
    /* storage unavailable */
  }
  return 'map';
}

export default function App() {
  const ds = useDataset();
  const [tab, setTabState] = useState<TabId>(loadTab);
  const setTab = (t: TabId) => {
    setTabState(t);
    try {
      localStorage.setItem('tab', t);
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>Block H PM Test</h1>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        {ds && <ProgressStrip ds={ds} />}
      </header>
      <main>
        {!ds ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <BackupBanner ds={ds} onGo={() => setTab('data')} />
            {tab === 'map' && <MapView ds={ds} onGoCycles={() => setTab('cycles')} onGoSetup={() => setTab('setup')} />}
            {tab === 'cycles' && <CyclesView ds={ds} />}
            {tab === 'analysis' && <AnalysisView ds={ds} />}
            {tab === 'setup' && <SetupView ds={ds} />}
            {tab === 'data' && <DataView ds={ds} />}
          </>
        )}
      </main>
    </div>
  );
}

function ProgressStrip({ ds }: { ds: Dataset }) {
  const groupOf = new Map(ds.printers.map((p) => [p.id, p.group]));
  const counts: Record<Group, number> = { control: 0, maintenance: 0 };
  for (const r of ds.plateRuns) counts[groupOf.get(r.printerId)!]++;
  const goal = ds.settings.goalPerGroup;
  const cycle = openCycle(ds);
  return (
    <div className="progress-strip">
      <span className="progress secondary">{cycle ? `Cycle ${cycle.number} open` : 'No open cycle'}</span>
      {(['control', 'maintenance'] as Group[]).map((g) => (
        <span key={g} className="progress">
          <span className={`gtag g-${g}`}>{GROUP_LABEL[g]}</span>
          <span className="bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (counts[g] / goal) * 100)}%`, background: g === 'control' ? 'var(--control)' : 'var(--maint)' }} />
          </span>
          <span className="num">
            {counts[g]}/{goal}
          </span>
        </span>
      ))}
    </div>
  );
}

function BackupBanner({ ds, onGo }: { ds: Dataset; onGo: () => void }) {
  const hasData = ds.plateRuns.length > 0 || ds.oneTime.length > 0;
  if (!hasData) return null;
  const last = ds.settings.lastBackupAt;
  const lastClosed = ds.cycles
    .map((c) => c.endedAt)
    .filter((x): x is string => !!x)
    .sort()
    .at(-1);
  const stale = !last || Date.now() - Date.parse(last) > 24 * 3_600_000 || (lastClosed !== undefined && lastClosed > last);
  if (!stale) return null;
  return (
    <div className="banner no-print" role="status">
      <strong>⚠ Back up now.</strong>
      <span className="secondary">
        {last ? `Last backup ${new Date(last).toLocaleString()}.` : 'No backup yet.'} The data lives only on this iPad.
      </span>
      <span className="spacer" />
      <button className="btn small" onClick={onGo}>
        Go to backup
      </button>
    </div>
  );
}
