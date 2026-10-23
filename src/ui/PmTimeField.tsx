import type { Dataset, OneTimeStepKey } from '../domain/types';
import { createRecord, updateRecord, voidRecord } from '../db/db';
import { CommitNumberField, fmtNum } from './common';

/**
 * One editable total of maintenance minutes for the whole Maintenance group (per one-time step,
 * or per cycle for per-print work). Typing a new number replaces the old one; the audit log keeps history.
 */
export function PmTimeField({
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
  const entries = ds.pmTime.filter((t) => t.scope === scope && (scope === 'one_time' ? t.step === step : t.cycleId === cycleId));
  // Older data could hold several added-up entries; their sum is the total.
  const total = entries.length ? entries.reduce((s, t) => s + t.minutes, 0) : undefined;

  async function save(v: number | undefined) {
    if (v === undefined || v <= 0) {
      for (const e of entries) await voidRecord('pmTime', e.id);
    } else if (entries.length === 1) {
      await updateRecord('pmTime', entries[0].id, { minutes: v });
    } else {
      for (const e of entries) await voidRecord('pmTime', e.id);
      await createRecord('pmTime', { scope, step, cycleId, minutes: v });
    }
  }

  return (
    <div className="stack">
      <CommitNumberField label="Total time for the whole group" suffix="min" value={total} onCommit={save} min={0} />
      <span className="secondary num small">
        {total && divisor > 0 ? `≈ ${fmtNum(total / divisor, 1)} min per ${divisorLabel} (over ${divisor})` : `– min per ${divisorLabel}`}
      </span>
    </div>
  );
}
