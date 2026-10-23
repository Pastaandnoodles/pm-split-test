import { useState } from 'react';
import {
  ONE_TIME_STEPS,
  ONE_TIME_STEP_LABELS,
  type Dataset,
  type Group,
  type OneTimeStepKey,
  type Printer,
} from '../domain/types';
import { GROUP_SHORT, SHELVES, defaultGroup } from '../domain/printers';
import { createRecord, saveSettings, updateRecord, voidRecord } from '../db/db';
import { FileForm, PrintTimeFields, fmtPrintTime } from './CyclesView';
import { CommitNumberField, ConfirmButton } from './common';
import { PmTimeField } from './PmTimeField';

export function SetupView({ ds }: { ds: Dataset }) {
  return (
    <div className="section">
      <AssignmentCard ds={ds} />
      <OneTimeCard ds={ds} />
      <FilesCard ds={ds} />
      <ValuesCard ds={ds} />
    </div>
  );
}

function AssignmentCard({ ds }: { ds: Dataset }) {
  const locked = ds.settings.testLocked;
  const counts = { control: 0, maintenance: 0 } as Record<Group, number>;
  for (const p of ds.printers) counts[p.group]++;
  const byPos = new Map(ds.printers.map((p) => [`${p.column}${p.row}`, p]));

  function toggle(p: Printer) {
    if (locked) return;
    const next: Group = p.group === 'control' ? 'maintenance' : 'control';
    const overrides = { ...ds.settings.groupOverrides };
    if (next === defaultGroup(p.column)) delete overrides[p.id];
    else overrides[p.id] = next;
    void saveSettings({ groupOverrides: overrides });
  }

  return (
    <div className="card stack">
      <div className="row">
        <h2>Group assignment</h2>
        {locked ? <span className="pill">🔒 Locked</span> : <span className="pill warn">Not locked</span>}
        <span className="secondary num">
          Control {counts.control} · Maintenance {counts.maintenance}
        </span>
      </div>
      <p className="secondary small" style={{ margin: 0 }}>
        Default: the left column of every shelf is Control and the right column is Maintenance. {locked ? 'Assignment is locked for the test.' : 'Tap a printer to switch its group. Starting the first cycle locks this.'}
      </p>
      {counts.control !== counts.maintenance && <div className="small st-fail">⚠ Groups are unequal.</div>}
      <div className="shelves" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
        {Array.from({ length: SHELVES }, (_, i) => i + 1).map((s) => (
          <div key={s} className="shelf">
            <div className="shelf-title">Shelf {s}</div>
            <div className="shelf-grid">
              {(['a', 'b'] as const).flatMap((row) =>
                [2 * s - 1, 2 * s].map((col) => {
                  const p = byPos.get(`${col}${row}`)!;
                  return (
                    <button key={p.id} className={`tile g-${p.group}`} style={{ minHeight: 52 }} disabled={locked} onClick={() => toggle(p)}>
                      <span className="tid small">{p.id.slice(2)}</span>
                      <span className="tgrp">{GROUP_SHORT[p.group]}</span>
                    </button>
                  );
                }),
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="btn-row">
        {!locked && (
          <>
            <ConfirmButton className="btn primary" onConfirm={() => saveSettings({ testLocked: true })}>
              🔒 Lock assignment
            </ConfirmButton>
            <button className="btn" onClick={() => saveSettings({ groupOverrides: {} })}>
              Reset to default
            </button>
          </>
        )}
        {locked && (
          <ConfirmButton
            className="btn small"
            onConfirm={async () => {
              await createRecord('deviations', { type: 'assignment_change', description: 'Group assignment unlocked for changes', excludeFromAnalysis: false });
              await saveSettings({ testLocked: false });
            }}
          >
            Unlock (logs a deviation)
          </ConfirmButton>
        )}
      </div>
    </div>
  );
}

function OneTimeCard({ ds }: { ds: Dataset }) {
  const maint = ds.printers.filter((p) => p.group === 'maintenance');
  const done = (pid: string, step: OneTimeStepKey) => ds.oneTime.find((s) => s.printerId === pid && s.step === step);
  const totalDone = maint.filter((p) => ONE_TIME_STEPS.every((s) => done(p.id, s))).length;
  const unlocked = (pid: string, i: number) => i === 0 || !!done(pid, ONE_TIME_STEPS[i - 1]);
  const laterDone = (pid: string, i: number) => ONE_TIME_STEPS.slice(i + 1).some((s) => done(pid, s));
  const ready = (i: number) => maint.filter((p) => !done(p.id, ONE_TIME_STEPS[i]) && unlocked(p.id, i));
  const markDone = (pid: string, step: OneTimeStepKey) => createRecord('oneTime', { printerId: pid, step, doneAt: new Date().toISOString() });

  return (
    <div className="card stack">
      <div className="row">
        <h2>One-time maintenance</h2>
        <span className="secondary num">
          {totalDone}/{maint.length} printers complete
        </span>
      </div>
      <p className="secondary small" style={{ margin: 0 }}>
        Maintenance group only, in this order: fans → debris → lead screws → nozzle tip. Tap a cell to mark that printer done (tap a ✓ twice to undo). A step unlocks once the
        previous one is done. Time isn't logged per printer: enter one total for each step for the whole group below (type a new number to correct it), and the app works out the average per printer.
      </p>
      <div className="grid-2">
        {ONE_TIME_STEPS.map((s, i) => {
          const n = maint.filter((p) => done(p.id, s)).length;
          return (
            <div key={s} className="card stack" style={{ background: 'var(--page)' }}>
              <h3>
                {i + 1}. {ONE_TIME_STEP_LABELS[s]}
              </h3>
              <span className="secondary num">
                {n}/{maint.length} printers done
              </span>
              <PmTimeField ds={ds} scope="one_time" step={s} divisor={n} divisorLabel="printer" />
            </div>
          );
        })}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Printer</th>
              {ONE_TIME_STEPS.map((s, i) => (
                <th key={s}>
                  {i + 1}. {ONE_TIME_STEP_LABELS[s]}
                </th>
              ))}
            </tr>
            <tr>
              <th />
              {ONE_TIME_STEPS.map((s, i) => {
                const r = ready(i);
                return (
                  <th key={s}>
                    <ConfirmButton className="btn small" disabled={r.length === 0} onConfirm={async () => { for (const p of r) await markDone(p.id, s); }}>
                      Mark all ready ({r.length})
                    </ConfirmButton>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {maint.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.id}</strong>
                </td>
                {ONE_TIME_STEPS.map((s, i) => {
                  const d = done(p.id, s);
                  return (
                    <td key={s}>
                      {d ? (
                        <ConfirmButton className="btn small" disabled={laterDone(p.id, i)} onConfirm={() => voidRecord('oneTime', d.id)}>
                          <span className="st-pass">✓</span> Done
                        </ConfirmButton>
                      ) : (
                        <button className="btn small" disabled={!unlocked(p.id, i)} onClick={() => markDone(p.id, s)}>
                          {unlocked(p.id, i) ? 'Mark done' : '—'}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PrintTimeEditor({ fileId, value }: { fileId: string; value?: number }) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState<number | undefined>(value === undefined ? undefined : Math.floor(value / 60));
  const [mins, setMins] = useState<number | undefined>(value === undefined ? undefined : value % 60);
  if (!open)
    return (
      <button className="btn small" onClick={() => setOpen(true)}>
        {value === undefined ? 'Set print time' : 'Edit print time'}
      </button>
    );
  const total = (hours ?? 0) * 60 + (mins ?? 0);
  return (
    <div className="row">
      <PrintTimeFields hours={hours} minutes={mins} onHours={setHours} onMinutes={setMins} />
      <button
        className="btn small primary"
        disabled={total <= 0}
        onClick={async () => {
          await updateRecord('files', fileId, { printTimeMin: total });
          setOpen(false);
        }}
      >
        Save
      </button>
    </div>
  );
}

function FilesCard({ ds }: { ds: Dataset }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="card stack">
      <div className="row">
        <h2>Print files</h2>
        <span className="spacer" />
        {!adding && (
          <button className="btn small" onClick={() => setAdding(true)}>
            + New file
          </button>
        )}
      </div>
      {ds.files.length === 0 && !adding && <p className="muted">No files yet.</p>}
      {ds.files.map((f) => (
        <div key={f.id} className="list-item">
          <strong>{f.name}</strong>
          <span className="secondary num">
            {f.partsPerPlate} per plate · {f.unitWeightG.toFixed(3)} g each
            {f.sampleCount ? ` (from ${f.sampleCount} weighing ${f.sampleWeightG} g)` : ''} · {fmtPrintTime(f.printTimeMin)}
          </span>
          <span className="spacer" />
          <PrintTimeEditor fileId={f.id} value={f.printTimeMin} />
        </div>
      ))}
      {adding && <FileForm onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} />}
    </div>
  );
}

function ValuesCard({ ds }: { ds: Dataset }) {
  const s = ds.settings;
  return (
    <div className="card stack">
      <h2>Test values</h2>
      <div className="grid-3">
        <CommitNumberField label="Plate goal per group" value={s.goalPerGroup} onCommit={(v) => v && saveSettings({ goalPerGroup: v })} step="1" min={1} />
        <CommitNumberField label="Calibration machine time per print" suffix="min" value={s.calibrationMachineMinutes} onCommit={(v) => saveSettings({ calibrationMachineMinutes: v ?? 0 })} min={0} />
        <CommitNumberField label="Missing-parts tolerance" suffix="%" value={s.missingTolerancePct} onCommit={(v) => saveSettings({ missingTolerancePct: v ?? 2 })} min={0} />
      </div>
      <h3>Dollar values (for the win calculation)</h3>
      <p className="secondary small" style={{ margin: 0 }}>
        These can be filled in any time. Until they are, Analysis shows minutes and part counts instead of dollars.
      </p>
      <div className="grid-3">
        <CommitNumberField label="Labor rate" suffix="$/hr" value={s.laborRatePerHr} onCommit={(v) => saveSettings({ laborRatePerHr: v })} min={0} />
        <CommitNumberField label="Value per good wigglitz" suffix="$" value={s.valuePerGoodPart} onCommit={(v) => saveSettings({ valuePerGoodPart: v })} min={0} />
        <CommitNumberField label="Filament cost" suffix="$/kg" value={s.filamentCostPerKg} onCommit={(v) => saveSettings({ filamentCostPerKg: v })} min={0} />
        <CommitNumberField label="Machine-hour value" suffix="$/hr" value={s.machineHourValue} onCommit={(v) => saveSettings({ machineHourValue: v })} min={0} />
      </div>
    </div>
  );
}
