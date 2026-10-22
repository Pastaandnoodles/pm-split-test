import { useState } from 'react';
import { ONE_TIME_STEPS, ONE_TIME_STEP_LABELS, DEFAULT_PASS_FAIL_RULE, type Dataset, type Group, type OneTimeStepKey, type Printer } from '../domain/types';
import { GROUP_SHORT, SHELVES, defaultGroup } from '../domain/printers';
import { createRecord, saveSettings, voidRecord } from '../db/db';
import { FileForm } from './CyclesView';
import { CommitNumberField, ConfirmButton, NumberField, Sheet, TextField, fmtTime } from './common';

export function SetupView({ ds }: { ds: Dataset }) {
  return (
    <div className="section">
      <AssignmentCard ds={ds} />
      <OneTimeCard ds={ds} />
      <FilesCard ds={ds} />
      <ValuesCard ds={ds} />
      <PartCostsCard ds={ds} />
      <RuleCard ds={ds} />
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
  const [editing, setEditing] = useState<{ printer: Printer; step: OneTimeStepKey } | null>(null);
  const maint = ds.printers.filter((p) => p.group === 'maintenance');
  const done = (pid: string, step: OneTimeStepKey) => ds.oneTime.find((s) => s.printerId === pid && s.step === step);
  const totalDone = maint.filter((p) => ONE_TIME_STEPS.every((s) => done(p.id, s))).length;

  return (
    <div className="card stack">
      <div className="row">
        <h2>One-time maintenance</h2>
        <span className="secondary num">
          {totalDone}/{maint.length} printers complete
        </span>
      </div>
      <p className="secondary small" style={{ margin: 0 }}>
        Maintenance group only, in this order: fans → debris → lead screws → nozzle tip. Tap a step to record its minutes. A step unlocks once the previous one is done.
      </p>
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
          </thead>
          <tbody>
            {maint.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.id}</strong>
                </td>
                {ONE_TIME_STEPS.map((s, i) => {
                  const d = done(p.id, s);
                  const unlocked = i === 0 || !!done(p.id, ONE_TIME_STEPS[i - 1]);
                  return (
                    <td key={s}>
                      {d ? (
                        <button className="btn small" onClick={() => setEditing({ printer: p, step: s })}>
                          <span className="st-pass">✓</span> {d.minutes} min
                        </button>
                      ) : (
                        <button className="btn small" disabled={!unlocked} onClick={() => setEditing({ printer: p, step: s })}>
                          {unlocked ? 'Mark done' : '—'}
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
      {editing && <StepSheet ds={ds} printer={editing.printer} step={editing.step} onClose={() => setEditing(null)} />}
    </div>
  );
}

function StepSheet({ ds, printer, step, onClose }: { ds: Dataset; printer: Printer; step: OneTimeStepKey; onClose: () => void }) {
  const existing = ds.oneTime.find((s) => s.printerId === printer.id && s.step === step);
  const [minutes, setMinutes] = useState<number | undefined>(existing?.minutes);
  const later = ONE_TIME_STEPS.slice(ONE_TIME_STEPS.indexOf(step) + 1).some((s) => ds.oneTime.some((x) => x.printerId === printer.id && x.step === s));
  return (
    <Sheet title={<h2>{printer.id}: {ONE_TIME_STEP_LABELS[step]}</h2>} onClose={onClose}>
      {existing && <p className="secondary">Done {fmtTime(existing.doneAt)}</p>}
      <NumberField label="Time spent on this printer" suffix="min" value={minutes} onChange={setMinutes} min={0} />
      <div className="btn-row">
        <button
          className="btn primary"
          disabled={minutes === undefined}
          onClick={async () => {
            if (existing) await voidRecord('oneTime', existing.id);
            await createRecord('oneTime', { printerId: printer.id, step, minutes: minutes!, doneAt: existing?.doneAt ?? new Date().toISOString() });
            onClose();
          }}
        >
          {existing ? 'Update' : 'Mark done'}
        </button>
        {existing && !later && (
          <ConfirmButton
            onConfirm={async () => {
              await voidRecord('oneTime', existing.id);
              onClose();
            }}
          >
            Undo step
          </ConfirmButton>
        )}
      </div>
    </Sheet>
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
            {f.sampleCount ? ` (from ${f.sampleCount} weighing ${f.sampleWeightG} g)` : ''}
          </span>
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
        <CommitNumberField label="Per-print PM labor default" suffix="min" value={s.perPrintPmMinutesDefault} onCommit={(v) => saveSettings({ perPrintPmMinutesDefault: v ?? 0 })} min={0} />
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

function PartCostsCard({ ds }: { ds: Dataset }) {
  const [name, setName] = useState('');
  const [cost, setCost] = useState<number>();
  const costs = ds.settings.partCosts;
  const used = [...new Set(ds.reactive.map((r) => r.part).filter((p): p is string => !!p && !(p in costs)))];
  return (
    <div className="card stack">
      <h2>Replacement part costs</h2>
      {Object.entries(costs).map(([part, c]) => (
        <div key={part} className="list-item">
          <strong>{part}</strong>
          <span className="secondary num">${c.toFixed(2)}</span>
          <span className="spacer" />
          <ConfirmButton
            onConfirm={() => {
              const next = { ...costs };
              delete next[part];
              void saveSettings({ partCosts: next });
            }}
          >
            Remove
          </ConfirmButton>
        </div>
      ))}
      {used.length > 0 && <div className="small secondary">Parts logged without a cost: {used.join(', ')}</div>}
      <div className="grid-3">
        <TextField label="Part name" value={name} onChange={setName} />
        <NumberField label="Cost" suffix="$" value={cost} onChange={setCost} min={0} />
        <button
          className="btn"
          style={{ alignSelf: 'flex-end' }}
          disabled={!name.trim() || cost === undefined}
          onClick={async () => {
            await saveSettings({ partCosts: { ...costs, [name.trim()]: cost! } });
            setName('');
            setCost(undefined);
          }}
        >
          Save part cost
        </button>
      </div>
    </div>
  );
}

function RuleCard({ ds }: { ds: Dataset }) {
  const [text, setText] = useState(ds.settings.passFailRuleText);
  return (
    <div className="card stack">
      <h2>Pass/fail rule</h2>
      <p className="secondary small" style={{ margin: 0 }}>
        Shown on the outcome screen for every plate.
      </p>
      <label className="field">
        <span>Rule text</span>
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="btn-row">
        <button className="btn primary" disabled={text === ds.settings.passFailRuleText} onClick={() => saveSettings({ passFailRuleText: text })}>
          Save rule
        </button>
        <button className="btn" onClick={() => setText(DEFAULT_PASS_FAIL_RULE)}>
          Restore default
        </button>
      </div>
    </div>
  );
}
