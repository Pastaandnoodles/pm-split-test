import { useState } from 'react';
import type { Dataset, PlateRun, Printer } from '../domain/types';
import { GROUP_SHORT, SHELVES } from '../domain/printers';
import { openCycle, openDowntime } from '../db/useDataset';
import { PrinterSheet } from './PrinterSheet';

export function MapView({ ds, onGoCycles, onGoSetup }: { ds: Dataset; onGoCycles: () => void; onGoSetup: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const cycle = openCycle(ds);
  const runs = new Map<string, PlateRun>();
  if (cycle) for (const r of ds.plateRuns) if (r.cycleId === cycle.id) runs.set(r.printerId, r);
  const logged = runs.size;
  const downCount = ds.printers.filter((p) => openDowntime(ds, p.id)).length;

  const byPos = new Map(ds.printers.map((p) => [`${p.column}${p.row}`, p]));
  const shelves = Array.from({ length: SHELVES }, (_, i) => i + 1);

  return (
    <div>
      {!ds.settings.testLocked && (
        <div className="banner info">
          <span>Group assignment isn't locked yet. Check it and do the one-time maintenance on the Setup tab first.</span>
          <span className="spacer" />
          <button className="btn small" onClick={onGoSetup}>
            Setup
          </button>
        </div>
      )}
      {!cycle && (
        <div className="banner info">
          <span>No cycle is open. Start one on the Cycles tab to log plates. You can still log downtime and repairs here.</span>
          <span className="spacer" />
          <button className="btn small" onClick={onGoCycles}>
            Cycles
          </button>
        </div>
      )}
      <div className="row" style={{ marginBottom: 12 }}>
        <h2>{cycle ? `Cycle ${cycle.number}` : 'Shelf map'}</h2>
        {cycle && (
          <span className="secondary num">
            {logged}/76 plates logged · {76 - logged - downCount} pending{downCount ? ` · ${downCount} down` : ''}
          </span>
        )}
      </div>
      <div className="legend">
        <span className="gtag g-control">C = Control (left column)</span>
        <span className="gtag g-maintenance">M = Maintenance (right column)</span>
        <span>
          <span className="st-pass">✓</span> Pass
        </span>
        <span>
          <span className="st-fail">✕</span> Fail
        </span>
        <span>
          <span className="st-down">⏸</span> Down
        </span>
        <span>E = error codes · R = repairs this cycle</span>
      </div>
      <div className="shelves">
        {shelves.map((s) => (
          <div key={s} className="shelf">
            <div className="shelf-title">Shelf {s}</div>
            <div className="shelf-grid">
              {(['a', 'b'] as const).flatMap((row) =>
                [2 * s - 1, 2 * s].map((col) => {
                  const p = byPos.get(`${col}${row}`)!;
                  return <Tile key={p.id} p={p} ds={ds} run={runs.get(p.id)} cycleId={cycle?.id} onOpen={() => setSelected(p.id)} />;
                }),
              )}
            </div>
          </div>
        ))}
      </div>
      {selected && <PrinterSheet ds={ds} printerId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Tile({ p, ds, run, cycleId, onOpen }: { p: Printer; ds: Dataset; run?: PlateRun; cycleId?: string; onOpen: () => void }) {
  const down = openDowntime(ds, p.id);
  const errs = cycleId ? ds.errorCodes.filter((e) => e.cycleId === cycleId && e.printerId === p.id).length : 0;
  const reps = cycleId ? ds.reactive.filter((r) => r.cycleId === cycleId && r.printerId === p.id).length : 0;
  let status = <span className="tstatus muted">· Pending</span>;
  if (run?.outcome === 'pass') status = <span className="tstatus st-pass">✓ Pass</span>;
  else if (run?.outcome === 'fail_finished') status = <span className="tstatus st-fail">✕ Fail</span>;
  else if (run?.outcome === 'fail_stopped') status = <span className="tstatus st-fail">✕ {run.stoppedBy === 'canceled' ? 'Canceled' : 'Stopped'}</span>;
  else if (down) status = <span className="tstatus st-down">⏸ Down</span>;
  else if (!cycleId) status = <span className="tstatus muted">&nbsp;</span>;
  return (
    <button className={`tile g-${p.group}${run ? ' done' : ''}${down ? ' down' : ''}`} onClick={onOpen} aria-label={`${p.id} ${p.group}`}>
      <span className="trow">
        <span className="tid">{p.id}</span>
        <span className="tgrp">{GROUP_SHORT[p.group]}</span>
      </span>
      <span className="trow">
        {status}
        <span className="badges">
          {errs > 0 && <span className="badge">E{errs}</span>}
          {reps > 0 && <span className="badge">R{reps}</span>}
        </span>
      </span>
    </button>
  );
}
