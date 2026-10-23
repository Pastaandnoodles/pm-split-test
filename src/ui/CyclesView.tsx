import { useState } from 'react';
import { BIN_KINDS, BIN_KIND_LABELS, type BinKind, type Cycle, type Dataset, type Group } from '../domain/types';
import { PmTimeLog } from './PmTimeLog';
import { computeGroupCycleYield, crossBinHint, findBin, type GroupCycleYield } from '../domain/yield';
import { createRecord, saveSettings, updateRecord } from '../db/db';
import { openCycle, openDowntime } from '../db/useDataset';
import { CommitNumberField, ConfirmButton, GroupTag, NumberField, TextField, fmtNum, fmtPct, fmtTime } from './common';

const GROUPS: Group[] = ['control', 'maintenance'];

export function CyclesView({ ds }: { ds: Dataset }) {
  const open = openCycle(ds);
  const past = ds.cycles.filter((c) => c.endedAt).sort((a, b) => b.number - a.number);
  return (
    <div className="section">
      {open ? <CycleCard ds={ds} cycle={open} isOpen /> : <StartCycle ds={ds} />}
      {past.length > 0 && <h2>Closed cycles</h2>}
      {past.map((c) => (
        <CycleCard key={c.id} ds={ds} cycle={c} />
      ))}
    </div>
  );
}

function StartCycle({ ds }: { ds: Dataset }) {
  const lastFile = ds.cycles.at(-1)?.fileId;
  const [fileId, setFileId] = useState<string | undefined>(lastFile ?? ds.files.at(-1)?.id);
  const [adding, setAdding] = useState(ds.files.length === 0);
  const next = (ds.cycles.at(-1)?.number ?? 0) + 1;
  const tare = ds.cycles.at(-1)?.binTareG;

  async function start() {
    if (!ds.settings.testLocked) await saveSettings({ testLocked: true });
    await createRecord('cycles', { number: next, fileId: fileId!, startedAt: new Date().toISOString(), binTareG: tare });
  }

  return (
    <div className="card stack">
      <h2>Start cycle {next}</h2>
      {ds.files.length > 0 && (
        <label className="field">
          <span>Print file</span>
          <select value={fileId ?? ''} onChange={(e) => setFileId(e.target.value || undefined)}>
            <option value="">Choose…</option>
            {ds.files.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} · {f.partsPerPlate}/plate · {f.unitWeightG.toFixed(3)} g each
              </option>
            ))}
          </select>
        </label>
      )}
      {adding ? (
        <FileForm
          onSaved={(id) => {
            setFileId(id);
            setAdding(false);
          }}
          onCancel={ds.files.length ? () => setAdding(false) : undefined}
        />
      ) : (
        <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>
          + New file
        </button>
      )}
      {!ds.settings.testLocked && <div className="small secondary">⚠ Starting the first cycle locks the group assignment.</div>}
      <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={!fileId} onClick={start}>
        Start cycle {next}
      </button>
    </div>
  );
}

export function FileForm({ onSaved, onCancel }: { onSaved?: (id: string) => void; onCancel?: () => void }) {
  const [name, setName] = useState('');
  const [ppp, setPpp] = useState<number>();
  const [sampleCount, setSampleCount] = useState<number | undefined>(20);
  const [sampleWeight, setSampleWeight] = useState<number>();
  const unit = sampleCount && sampleWeight ? sampleWeight / sampleCount : undefined;
  const ok = name.trim() && ppp && ppp > 0 && unit && unit > 0;
  return (
    <div className="card stack" style={{ background: 'var(--page)' }}>
      <h3>New print file</h3>
      <div className="grid-2">
        <TextField label="File name" value={name} onChange={setName} />
        <NumberField label="Wigglitz per plate" value={ppp} onChange={setPpp} step="1" min={1} />
      </div>
      <p className="secondary small" style={{ margin: 0 }}>
        <strong>Sample weighing:</strong> count out some good wigglitz from this file (20 is plenty), put them on the scale together, and enter the count and the total weight.
        The app divides to get the weight of one wigglitz, which turns every bin weight into a part count.
      </p>
      <div className="grid-2">
        <NumberField label="How many wigglitz on the scale" value={sampleCount} onChange={setSampleCount} step="1" min={1} />
        <NumberField label="Their total weight" suffix="g" value={sampleWeight} onChange={setSampleWeight} min={0} />
      </div>
      <span className="secondary">Weight of one wigglitz: {unit ? `${unit.toFixed(3)} g` : '–'}</span>
      <div className="btn-row">
        <button
          className="btn primary"
          disabled={!ok}
          onClick={async () => {
            const id = await createRecord('files', { name: name.trim(), partsPerPlate: ppp!, unitWeightG: unit!, sampleCount, sampleWeightG: sampleWeight });
            onSaved?.(id);
            setName('');
            setPpp(undefined);
            setSampleWeight(undefined);
          }}
        >
          Save file
        </button>
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function CycleCard({ ds, cycle, isOpen }: { ds: Dataset; cycle: Cycle; isOpen?: boolean }) {
  const file = ds.files.find((f) => f.id === cycle.fileId);
  const runs = ds.plateRuns.filter((r) => r.cycleId === cycle.id);
  const down = ds.printers.filter((p) => openDowntime(ds, p.id) && !runs.some((r) => r.printerId === p.id)).length;
  const pending = 76 - runs.length - (isOpen ? down : 0);
  const yields = Object.fromEntries(
    GROUPS.map((g) => [g, computeGroupCycleYield(cycle, file, g, ds.plateRuns, ds.printers, ds.bins, ds.settings.missingTolerancePct)]),
  ) as Record<Group, GroupCycleYield>;
  const hint = crossBinHint(yields.control, yields.maintenance, file?.partsPerPlate ?? 0);

  return (
    <div className="card stack">
      <div className="row">
        <h2>Cycle {cycle.number}</h2>
        {isOpen ? <span className="pill warn">Open</span> : <span className="pill">Closed</span>}
        <span className="secondary small">
          {file?.name ?? 'No file'} · started {fmtTime(cycle.startedAt)}
          {cycle.endedAt ? ` · closed ${fmtTime(cycle.endedAt)}` : ''}
        </span>
        <span className="spacer" />
        {isOpen ? (
          pending > 0 ? (
            <ConfirmButton className="btn" onConfirm={() => updateRecord('cycles', cycle.id, { endedAt: new Date().toISOString() })}>
              Close cycle ({pending} pending)
            </ConfirmButton>
          ) : (
            <button className="btn primary" onClick={() => updateRecord('cycles', cycle.id, { endedAt: new Date().toISOString() })}>
              Close cycle
            </button>
          )
        ) : (
          <ConfirmButton className="btn small" onConfirm={() => updateRecord('cycles', cycle.id, { endedAt: undefined })}>
            Reopen
          </ConfirmButton>
        )}
      </div>
      <span className="secondary num">
        {runs.length}/76 plates logged{isOpen && down ? ` · ${down} printers down` : ''}
      </span>

      <h3>Bin weights</h3>
      <p className="secondary small" style={{ margin: 0 }}>
        Good = sold. Seconds = donated, not sold. Scrap = unredeemable, recycled. Enter each bin's gross weight (bin + parts).
      </p>
      <div className="grid-3">
        <CommitNumberField label="Empty bin (tare)" suffix="g" value={cycle.binTareG} onCommit={(v) => updateRecord('cycles', cycle.id, { binTareG: v })} min={0} />
      </div>
      {GROUPS.map((g) => (
        <div key={g} className="stack">
          <GroupTag group={g} />
          <div className="grid-3">
            {BIN_KINDS.map((k) => (
              <BinField key={k} ds={ds} cycleId={cycle.id} group={g} kind={k} />
            ))}
          </div>
        </div>
      ))}

      <div className="stack">
        <h3>Per-print maintenance time (whole Maintenance group)</h3>
        <span className="secondary small">Plate cleaning, calibration and purge clearing for all Maintenance printers this cycle.</span>
        <PmTimeLog
          ds={ds}
          scope="per_print"
          cycleId={cycle.id}
          divisor={runs.filter((r) => ds.printers.find((p) => p.id === r.printerId)?.group === 'maintenance').length}
          divisorLabel="plate"
        />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Group</th>
              <th className="r">Plates</th>
              <th className="r">Passed</th>
              <th className="r">Expected parts</th>
              <th className="r">Good</th>
              <th className="r">Seconds</th>
              <th className="r">Scrap</th>
              <th className="r">Missing</th>
              <th className="r">QC yield</th>
              <th className="r">Overall yield</th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((g) => {
              const y = yields[g];
              return (
                <tr key={g}>
                  <td>
                    <GroupTag group={g} />
                  </td>
                  <td className="r">{y.platesStarted}</td>
                  <td className="r">{y.passedPlates}</td>
                  <td className="r">{fmtNum(y.expectedParts)}</td>
                  <td className="r">{fmtNum(y.goodParts)}</td>
                  <td className="r">{fmtNum(y.secondsParts)}</td>
                  <td className="r">{fmtNum(y.scrapParts)}</td>
                  <td className="r">{fmtNum(y.missingParts)}</td>
                  <td className="r">{fmtPct(y.qcYield)}</td>
                  <td className="r">{fmtPct(y.overallYield)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {[...yields.control.flags.map((f) => `Control: ${f}`), ...yields.maintenance.flags.map((f) => `Maintenance: ${f}`), ...(hint ? [hint] : [])].map((f) => (
        <div key={f} className="small st-fail">
          ⚠ {f}
        </div>
      ))}
      <CycleNotes cycle={cycle} />
    </div>
  );
}

function BinField({ ds, cycleId, group, kind }: { ds: Dataset; cycleId: string; group: Group; kind: BinKind }) {
  const bin = findBin(ds.bins, cycleId, group, kind);
  const label = `${group === 'control' ? 'Control' : 'Maintenance'}: ${BIN_KIND_LABELS[kind].toLowerCase()} bin`;
  return (
    <CommitNumberField
      label={label}
      suffix="g"
      value={bin?.grossG}
      min={0}
      onCommit={(v) => {
        if (v === undefined) return;
        if (bin) void updateRecord('bins', bin.id, { grossG: v });
        else void createRecord('bins', { cycleId, group, kind, grossG: v });
      }}
    />
  );
}

function CycleNotes({ cycle }: { cycle: Cycle }) {
  const [text, setText] = useState(cycle.notes ?? '');
  const dirty = text !== (cycle.notes ?? '');
  return (
    <div className="row">
      <div style={{ flex: 1 }}>
        <TextField label="Cycle notes" value={text} onChange={setText} />
      </div>
      <button className="btn" style={{ alignSelf: 'flex-end' }} disabled={!dirty} onClick={() => updateRecord('cycles', cycle.id, { notes: text })}>
        Save note
      </button>
    </div>
  );
}

