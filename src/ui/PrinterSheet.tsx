import { useEffect, useState } from 'react';
import {
  CANCEL_REASONS,
  CANCEL_REASON_LABELS,
  DEVIATION_TYPES,
  DEVIATION_TYPE_LABELS,
  FAILURE_TYPES,
  FAILURE_TYPE_LABELS,
  REACTIVE_ACTIONS,
  REACTIVE_ACTION_LABELS,
  type CancelReason,
  type Cycle,
  type Dataset,
  type DeviationType,
  type ErrorDisposition,
  type FailureType,
  type Outcome,
  type PlateRun,
  type Printer,
  type ReactiveAction,
  type StoppedBy,
} from '../domain/types';
import { createRecord, db, savePhoto, updateRecord, voidRecord } from '../db/db';
import { openCycle, openDowntime } from '../db/useDataset';
import { Check, ConfirmButton, GroupTag, NumberField, Segmented, Sheet, TextField, compressImage, fmtTime } from './common';

export function PrinterSheet({ ds, printerId, onClose }: { ds: Dataset; printerId: string; onClose: () => void }) {
  const printer = ds.printers.find((p) => p.id === printerId)!;
  const cycle = openCycle(ds);
  const down = openDowntime(ds, printerId);
  return (
    <Sheet
      onClose={onClose}
      title={
        <div className="row">
          <h2>{printer.id}</h2>
          <GroupTag group={printer.group} />
          <span className="secondary small">
            Shelf {printer.shelf} · {printer.row === 'a' ? 'Top' : 'Bottom'}
          </span>
        </div>
      }
    >
      <DowntimeCard printerId={printerId} down={down} />
      {cycle ? (
        <PlateCard key={cycle.id} ds={ds} printer={printer} cycle={cycle} />
      ) : (
        <div className="card muted">No cycle is open. Start a cycle on the Cycles tab to log a plate.</div>
      )}
      {cycle && <ErrorCodesCard ds={ds} printerId={printerId} cycleId={cycle.id} />}
      <ReactiveCard ds={ds} printerId={printerId} cycleId={cycle?.id} />
      <DeviationCard ds={ds} printerId={printerId} cycleId={cycle?.id} />
      <HistoryCard ds={ds} printerId={printerId} />
    </Sheet>
  );
}

function DowntimeCard({ printerId, down }: { printerId: string; down?: Dataset['downtime'][number] }) {
  const [reason, setReason] = useState('');
  if (down) {
    return (
      <div className="banner critical">
        <strong>⏸ Down since {fmtTime(down.downAt)}</strong>
        {down.reason && <span className="secondary">{down.reason}</span>}
        <span className="spacer" />
        <button className="btn primary" onClick={() => updateRecord('downtime', down.id, { upAt: new Date().toISOString() })}>
          Mark back up
        </button>
      </div>
    );
  }
  return (
    <div className="card row">
      <div style={{ flex: 1, minWidth: 220 }}>
        <TextField label="Printer down? Reason (optional)" value={reason} onChange={setReason} />
      </div>
      <button
        className="btn"
        style={{ alignSelf: 'flex-end' }}
        onClick={() => createRecord('downtime', { printerId, downAt: new Date().toISOString(), reason: reason || undefined })}
      >
        ⏸ Mark down
      </button>
    </div>
  );
}

type Draft = Omit<PlateRun, 'id' | 'createdAt' | 'updatedAt' | 'voided'>;

function emptyDraft(printer: Printer, cycle: Cycle): Draft {
  return {
    printerId: printer.id,
    cycleId: cycle.id,
    outcome: undefined as unknown as Outcome,
    checks: { purgeCleared: false, nozzleWiped: false, plateCleaned: false, calibrationRun: false },
    correctPlatePool: true,
  };
}

function PlateCard({ ds, printer, cycle }: { ds: Dataset; printer: Printer; cycle: Cycle }) {
  const existing = ds.plateRuns.find((r) => r.cycleId === cycle.id && r.printerId === printer.id);
  const [draft, setDraft] = useState<Draft>(() => existing ?? emptyDraft(printer, cycle));
  const [editing, setEditing] = useState(!existing);
  const [saving, setSaving] = useState(false);
  const isM = printer.group === 'maintenance';
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const isFail = draft.outcome === 'fail_finished' || draft.outcome === 'fail_stopped';
  const fatalCodes = ds.errorCodes.filter((e) => e.cycleId === cycle.id && e.printerId === printer.id && e.disposition === 'fatal');

  const problems: string[] = [];
  if (!draft.outcome) problems.push('Pick an outcome');
  if (isFail && !draft.failureType) problems.push('Pick a failure type');
  if (isFail && !draft.photoId) problems.push('Take a photo of the failure');
  if (draft.outcome === 'fail_stopped' && !draft.stoppedBy) problems.push('Say whether the printer failed or it was canceled');
  if (draft.outcome === 'fail_stopped' && draft.stoppedBy === 'canceled' && !draft.cancelReason) problems.push('Pick a cancel reason');
  if (draft.outcome === 'fail_stopped' && (draft.progressPct === undefined || draft.progressPct < 0 || draft.progressPct > 100))
    problems.push('Enter progress % (0–100) from the printer screen');
  const warnings: string[] = [];
  if (isFail && draft.scrapMassG === undefined) warnings.push('Scrap mass not entered');
  if (isM && !draft.checks.plateCleaned) warnings.push('Plate cleaning not checked: a deviation will be logged');
  if (isM && !draft.checks.calibrationRun) warnings.push('Calibration not checked: a deviation will be logged');
  if (!draft.correctPlatePool) warnings.push('Wrong plate pool: a deviation will be logged');

  async function save() {
    setSaving(true);
    try {
      const clean: Draft = { ...draft };
      if (clean.outcome === 'pass') {
        Object.assign(clean, { failureType: undefined, photoId: undefined, failureNote: undefined, fatalErrorId: undefined, progressPct: undefined, scrapMassG: undefined, stoppedBy: undefined, cancelReason: undefined });
      } else if (clean.outcome === 'fail_finished') {
        Object.assign(clean, { progressPct: undefined, stoppedBy: undefined, cancelReason: undefined });
      } else if (clean.stoppedBy !== 'canceled') clean.cancelReason = undefined;
      if (existing) await updateRecord('plateRuns', existing.id, clean);
      else await createRecord('plateRuns', clean);

      const prev = existing;
      const newly = (now: boolean, before: boolean | undefined) => now && (prev === undefined || !before);
      if (newly(!clean.correctPlatePool, prev ? !prev.correctPlatePool : undefined)) {
        await createRecord('deviations', { type: 'wrong_plate_pool', printerId: printer.id, cycleId: cycle.id, description: 'Plate from the wrong plate pool (auto-logged)', excludeFromAnalysis: false });
      }
      if (isM) {
        const missed = (['plateCleaned', 'calibrationRun'] as const).filter((k) => !clean.checks[k] && (prev === undefined || prev.checks[k]));
        if (missed.length) {
          await createRecord('deviations', {
            type: 'missed_step',
            printerId: printer.id,
            cycleId: cycle.id,
            description: `Missed per-print step: ${missed.map((k) => (k === 'plateCleaned' ? 'plate cleaning' : 'calibration')).join(', ')} (auto-logged)`,
            excludeFromAnalysis: false,
          });
        }
      }
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (!editing && existing) {
    return (
      <div className="card stack">
        <div className="row">
          <h3>Plate · Cycle {cycle.number}</h3>
          <span className="spacer" />
          <button className="btn small" onClick={() => setEditing(true)}>
            Edit
          </button>
          <ConfirmButton onConfirm={() => voidRecord('plateRuns', existing.id)}>Void</ConfirmButton>
        </div>
        <PlateSummary run={existing} />
      </div>
    );
  }

  return (
    <div className="card stack">
      <h3>Plate · Cycle {cycle.number}</h3>
      {isM && (
        <div className="stack">
          <span className="small secondary">Pre-print (Maintenance)</span>
          <div className="grid-2">
            <Check label="Plate cleaned (tape on tab)" checked={draft.checks.plateCleaned} onChange={(v) => set({ checks: { ...draft.checks, plateCleaned: v } })} />
            <Check label="Calibration run" checked={draft.checks.calibrationRun} onChange={(v) => set({ checks: { ...draft.checks, calibrationRun: v } })} />
            <Check label="Loose purge cleared (as needed)" checked={draft.checks.purgeCleared} onChange={(v) => set({ checks: { ...draft.checks, purgeCleared: v } })} />
            <Check label="Nozzle tip wiped (as needed)" checked={draft.checks.nozzleWiped} onChange={(v) => set({ checks: { ...draft.checks, nozzleWiped: v } })} />
          </div>
        </div>
      )}
      <Check
        label={isM ? 'Plate came from the cleaned (taped) pool' : 'Plate came from the normal farm pool'}
        checked={draft.correctPlatePool}
        onChange={(v) => set({ correctPlatePool: v })}
      />

      <span className="small secondary">Outcome</span>
      <div className="rule">{ds.settings.passFailRuleText}</div>
      <Segmented<Outcome>
        value={draft.outcome}
        onChange={(v) => set({ outcome: v })}
        options={[
          { value: 'pass', label: '✓ Pass' },
          { value: 'fail_finished', label: '✕ Fail, finished' },
          { value: 'fail_stopped', label: '✕ Fail, stopped' },
        ]}
      />

      {draft.outcome === 'fail_stopped' && (
        <>
          <Segmented<StoppedBy>
            value={draft.stoppedBy}
            onChange={(v) => set({ stoppedBy: v })}
            options={[
              { value: 'printer', label: 'Printer failed' },
              { value: 'canceled', label: 'Canceled' },
            ]}
          />
          {draft.stoppedBy === 'canceled' && (
            <Segmented<CancelReason>
              value={draft.cancelReason}
              onChange={(v) => set({ cancelReason: v })}
              options={CANCEL_REASONS.map((r) => ({ value: r, label: CANCEL_REASON_LABELS[r] }))}
            />
          )}
          <NumberField label="Progress when it stopped (from printer screen)" suffix="%" value={draft.progressPct} onChange={(v) => set({ progressPct: v })} min={0} max={100} />
        </>
      )}

      {isFail && (
        <>
          <span className="small secondary">Failure type</span>
          <Segmented<FailureType> value={draft.failureType} onChange={(v) => set({ failureType: v })} options={FAILURE_TYPES.map((t) => ({ value: t, label: FAILURE_TYPE_LABELS[t] }))} />
          <PhotoInput photoId={draft.photoId} onChange={(id) => set({ photoId: id })} />
          <NumberField label="Scrap mass" suffix="g" value={draft.scrapMassG} onChange={(v) => set({ scrapMassG: v })} min={0} />
          {fatalCodes.length > 0 && (
            <label className="field">
              <span>Linked fatal error code</span>
              <select value={draft.fatalErrorId ?? ''} onChange={(e) => set({ fatalErrorId: e.target.value || undefined })}>
                <option value="">None</option>
                {fatalCodes.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.code}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Note (optional)</span>
            <textarea value={draft.failureNote ?? ''} onChange={(e) => set({ failureNote: e.target.value || undefined })} />
          </label>
        </>
      )}

      {problems.length > 0 && draft.outcome && <div className="small st-fail">{problems.join(' · ')}</div>}
      {warnings.length > 0 && <div className="small secondary">⚠ {warnings.join(' · ')}</div>}
      <div className="btn-row">
        <button className="btn primary" disabled={problems.length > 0 || saving} onClick={save}>
          Save plate
        </button>
        {existing && (
          <button className="btn" onClick={() => { setDraft(existing); setEditing(false); }}>
            Cancel edit
          </button>
        )}
      </div>
    </div>
  );
}

function PlateSummary({ run }: { run: PlateRun }) {
  const label =
    run.outcome === 'pass'
      ? '✓ Pass'
      : run.outcome === 'fail_finished'
        ? '✕ Fail, finished'
        : `✕ Fail, stopped (${run.stoppedBy === 'canceled' ? `canceled: ${CANCEL_REASON_LABELS[run.cancelReason!]}` : 'printer failed'})`;
  return (
    <div className="stack">
      <strong className={run.outcome === 'pass' ? 'st-pass' : 'st-fail'}>{label}</strong>
      {run.failureType && <span>{FAILURE_TYPE_LABELS[run.failureType]}</span>}
      <span className="secondary small">
        {run.progressPct !== undefined && `Progress ${run.progressPct}% · `}
        {run.scrapMassG !== undefined && `Scrap ${run.scrapMassG} g · `}
        {run.correctPlatePool ? 'Correct plate pool' : 'Wrong plate pool'}
      </span>
      {run.failureNote && <span className="secondary">{run.failureNote}</span>}
      {run.photoId && <PhotoView id={run.photoId} />}
    </div>
  );
}

function PhotoInput({ photoId, onChange }: { photoId?: string; onChange: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack">
      <label className="btn" style={{ alignSelf: 'flex-start' }}>
        📷 {photoId ? 'Retake photo' : 'Take photo (required)'}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setBusy(true);
            try {
              onChange(await savePhoto(await compressImage(f)));
            } finally {
              setBusy(false);
              e.target.value = '';
            }
          }}
        />
      </label>
      {busy && <span className="muted small">Saving photo…</span>}
      {photoId && <PhotoView id={photoId} />}
    </div>
  );
}

function PhotoView({ id }: { id: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let u: string | undefined;
    void db.photos.get(id).then((p) => {
      if (p) setUrl((u = URL.createObjectURL(p.blob)));
    });
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [id]);
  return url ? <img className="photo-thumb" src={url} alt="Failure photo" /> : null;
}

function ErrorCodesCard({ ds, printerId, cycleId }: { ds: Dataset; printerId: string; cycleId: string }) {
  const [code, setCode] = useState('');
  const [disp, setDisp] = useState<ErrorDisposition>('resumed');
  const [note, setNote] = useState('');
  const list = ds.errorCodes.filter((e) => e.printerId === printerId && e.cycleId === cycleId);
  const known = [...new Set(ds.errorCodes.map((e) => e.code))].sort();
  return (
    <div className="card stack">
      <h3>Error codes from the printer sheet</h3>
      {list.length > 0 && (
        <div className="list">
          {list.map((e) => (
            <div key={e.id} className="list-item">
              <strong className="num">{e.code}</strong>
              <span className={e.disposition === 'fatal' ? 'st-fail' : 'secondary'}>{e.disposition === 'fatal' ? '✕ Fatal' : '↻ Resumed'}</span>
              {e.note && <span className="secondary small">{e.note}</span>}
              <span className="spacer" />
              <ConfirmButton onConfirm={() => voidRecord('errorCodes', e.id)}>Void</ConfirmButton>
            </div>
          ))}
        </div>
      )}
      <div className="grid-2">
        <TextField label="HMS code" value={code} onChange={(v) => setCode(v.toUpperCase())} placeholder="0300-0100-0001-0007" list="known-codes" caps />
        <TextField label="Note (optional)" value={note} onChange={setNote} />
      </div>
      <datalist id="known-codes">
        {known.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="row">
        <Segmented<ErrorDisposition>
          value={disp}
          onChange={setDisp}
          options={[
            { value: 'resumed', label: '↻ Resumed' },
            { value: 'fatal', label: '✕ Fatal' },
          ]}
        />
        <span className="spacer" />
        <button
          className="btn primary"
          disabled={!code.trim()}
          onClick={async () => {
            await createRecord('errorCodes', { printerId, cycleId, code: code.trim(), disposition: disp, note: note || undefined });
            setCode('');
            setNote('');
          }}
        >
          Add code
        </button>
      </div>
    </div>
  );
}

function ReactiveCard({ ds, printerId, cycleId }: { ds: Dataset; printerId: string; cycleId?: string }) {
  const [action, setAction] = useState<ReactiveAction>();
  const [part, setPart] = useState('');
  const [minutes, setMinutes] = useState<number>();
  const list = ds.reactive.filter((r) => r.printerId === printerId && (cycleId ? r.cycleId === cycleId : !r.cycleId));
  const knownParts = [...new Set([...Object.keys(ds.settings.partCosts), ...ds.reactive.map((r) => r.part).filter((p): p is string => !!p)])].sort();
  return (
    <div className="card stack">
      <h3>Reactive maintenance{cycleId ? ' this cycle' : ''}</h3>
      {list.length > 0 && (
        <div className="list">
          {list.map((r) => (
            <div key={r.id} className="list-item">
              <strong>{REACTIVE_ACTION_LABELS[r.action]}</strong>
              {r.part && <span>Part: {r.part}</span>}
              <span className="secondary num">{r.minutes} min</span>
              <span className="spacer" />
              <ConfirmButton onConfirm={() => voidRecord('reactive', r.id)}>Void</ConfirmButton>
            </div>
          ))}
        </div>
      )}
      <Segmented<ReactiveAction> value={action} onChange={setAction} options={REACTIVE_ACTIONS.map((a) => ({ value: a, label: REACTIVE_ACTION_LABELS[a] }))} />
      <div className="grid-2">
        <TextField label="Part replaced (optional)" value={part} onChange={setPart} list="known-parts" />
        <NumberField label="Time spent" suffix="min" value={minutes} onChange={setMinutes} min={0} />
      </div>
      <datalist id="known-parts">
        {knownParts.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <button
        className="btn primary"
        style={{ alignSelf: 'flex-start' }}
        disabled={!action || minutes === undefined}
        onClick={async () => {
          await createRecord('reactive', { printerId, cycleId, action: action!, part: part.trim() || undefined, minutes: minutes! });
          setAction(undefined);
          setPart('');
          setMinutes(undefined);
        }}
      >
        Add repair
      </button>
    </div>
  );
}

function DeviationCard({ ds, printerId, cycleId }: { ds: Dataset; printerId: string; cycleId?: string }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<DeviationType>();
  const [desc, setDesc] = useState('');
  const [exclude, setExclude] = useState(false);
  const list = ds.deviations.filter((d) => d.printerId === printerId);
  return (
    <div className="card stack">
      <div className="row">
        <h3>Deviations</h3>
        <span className="spacer" />
        {!open && (
          <button className="btn small" onClick={() => setOpen(true)}>
            + Log deviation
          </button>
        )}
      </div>
      {list.map((d) => (
        <div key={d.id} className="list-item">
          <strong>{DEVIATION_TYPE_LABELS[d.type]}</strong>
          <span className="secondary small">{d.description}</span>
          {d.excludeFromAnalysis && <span className="pill">Excluded</span>}
          <span className="spacer" />
          <ConfirmButton onConfirm={() => voidRecord('deviations', d.id)}>Void</ConfirmButton>
        </div>
      ))}
      {open && (
        <>
          <Segmented<DeviationType> value={type} onChange={setType} options={DEVIATION_TYPES.map((t) => ({ value: t, label: DEVIATION_TYPE_LABELS[t] }))} />
          <label className="field">
            <span>What happened</span>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} />
          </label>
          <Check label={cycleId ? "Exclude this printer's plate this cycle from analysis" : 'Exclude from analysis'} checked={exclude} onChange={setExclude} />
          <div className="btn-row">
            <button
              className="btn primary"
              disabled={!type || !desc.trim()}
              onClick={async () => {
                await createRecord('deviations', { type: type!, printerId, cycleId, description: desc.trim(), excludeFromAnalysis: exclude });
                setOpen(false);
                setType(undefined);
                setDesc('');
                setExclude(false);
              }}
            >
              Save deviation
            </button>
            <button className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function HistoryCard({ ds, printerId }: { ds: Dataset; printerId: string }) {
  const cycleNo = new Map(ds.cycles.map((c) => [c.id, c.number]));
  const runs = ds.plateRuns.filter((r) => r.printerId === printerId).sort((a, b) => (cycleNo.get(a.cycleId) ?? 0) - (cycleNo.get(b.cycleId) ?? 0));
  if (!runs.length) return null;
  const pass = runs.filter((r) => r.outcome === 'pass').length;
  return (
    <div className="card stack">
      <h3>History</h3>
      <span className="secondary num">
        {pass}/{runs.length} plates passed
      </span>
      <div className="row small">
        {runs.map((r) => (
          <span key={r.id} className={r.outcome === 'pass' ? 'st-pass' : 'st-fail'}>
            C{cycleNo.get(r.cycleId)} {r.outcome === 'pass' ? '✓' : '✕'}
          </span>
        ))}
      </div>
    </div>
  );
}
