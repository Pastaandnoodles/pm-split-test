import { findBin } from './yield';
import { BIN_KINDS, BIN_KIND_LABELS, type Cycle, type Dataset, type Group } from './types';
import { GROUP_LABEL } from './printers';

/**
 * What a cycle still needs before its data is complete. Printers that were down at any point
 * during the cycle aren't expected to have a plate.
 */
export function missingCycleData(ds: Dataset, cycle: Cycle, now = new Date().toISOString()): string[] {
  const missing: string[] = [];
  const end = cycle.endedAt ?? now;
  const wasDown = new Set(
    ds.downtime.filter((d) => !d.voided && d.downAt < end && (d.upAt ?? now) > cycle.startedAt).map((d) => d.printerId),
  );
  const logged = new Set(ds.plateRuns.filter((r) => !r.voided && r.cycleId === cycle.id).map((r) => r.printerId));
  const notLogged = ds.printers.filter((p) => !logged.has(p.id) && !wasDown.has(p.id)).length;
  if (notLogged > 0) missing.push(`${notLogged} plate${notLogged === 1 ? '' : 's'} not logged`);

  if (cycle.binTareG === undefined) missing.push('Empty bin (tare) weight');
  for (const g of ['control', 'maintenance'] as Group[]) {
    for (const k of BIN_KINDS) if (!findBin(ds.bins, cycle.id, g, k)) missing.push(`${GROUP_LABEL[g]} ${BIN_KIND_LABELS[k].toLowerCase()} bin weight`);
  }
  if (!ds.pmTime.some((t) => !t.voided && t.scope === 'per_print' && t.cycleId === cycle.id)) missing.push('Per-print maintenance time');
  const file = ds.files.find((f) => f.id === cycle.fileId);
  if (!file) missing.push('Print file');
  else if (file.printTimeMin === undefined) missing.push(`Print time for file "${file.name}"`);
  return missing;
}
