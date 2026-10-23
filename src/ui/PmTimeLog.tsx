import { useState } from 'react';
import type { Dataset, OneTimeStepKey } from '../domain/types';
import { createRecord, voidRecord } from '../db/db';
import { ConfirmButton, NumberField, fmtNum, fmtTime } from './common';

/**
 * Logs maintenance time for the whole Maintenance group. Several entries add up,
 * so time can be logged in sessions (e.g. one entry per shift).
 */
export function PmTimeLog({
  ds,
  scope,
  step,
  cycleId,
  divisor,
  divisorLabel,
}: {
  ds: Dataset;
  scope: 'one_time' | 'per_print';
  step?: OneTimeStepKey;
  cycleId?: string;
  divisor: number; // printers done (one-time) or Maintenance plates (per-print)
  divisorLabel: string; // "printer" / "plate"
}) {
  const [minutes, setMinutes] = useState<number>();
  const entries = ds.pmTime.filter((t) => t.scope === scope && (scope === 'one_time' ? t.step === step : t.cycleId === cycleId));
  const total = entries.reduce((s, t) => s + t.minutes, 0);
  return (
    <div className="stack">
      <div className="row">
        <strong className="num">{fmtNum(total)} min total</strong>
        <span className="secondary num">
          {total > 0 && divisor > 0 ? `≈ ${fmtNum(total / divisor, 1)} min per ${divisorLabel} (over ${divisor})` : `– min per ${divisorLabel}`}
        </span>
      </div>
      {entries.map((t) => (
        <div key={t.id} className="list-item small">
          <span className="num">+{t.minutes} min</span>
          <span className="muted">{fmtTime(t.createdAt)}</span>
          <span className="spacer" />
          <ConfirmButton onConfirm={() => voidRecord('pmTime', t.id)}>Void</ConfirmButton>
        </div>
      ))}
      <div className="row">
        <div style={{ flex: 1, minWidth: 160 }}>
          <NumberField label="Add group time" suffix="min"value={minutes} onChange={setMinutes} min={0} />
        </div>
        <button
          className="btn"
          style={{ alignSelf: 'flex-end' }}
          disabled={!minutes}
          onClick={async () => {
            await createRecord('pmTime', { scope, step, cycleId, minutes: minutes! });
            setMinutes(undefined);
          }}
        >
          Add time
        </button>
      </div>
    </div>
  );
}
