import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings } from './db';
import { buildPrinters } from '../domain/printers';
import type { Dataset } from '../domain/types';

/** Live view of every table except photos. The data set is small (a few thousand rows), so loading it all is fine. */
export function useDataset(): Dataset | undefined {
  return useLiveQuery(async () => {
    const [settings, files, cycles, plateRuns, errorCodes, reactive, downtime, bins, deviations, oneTime] = await Promise.all([
      getSettings(),
      db.files.toArray(),
      db.cycles.toArray(),
      db.plateRuns.toArray(),
      db.errorCodes.toArray(),
      db.reactive.toArray(),
      db.downtime.toArray(),
      db.bins.toArray(),
      db.deviations.toArray(),
      db.oneTime.toArray(),
    ]);
    return {
      printers: buildPrinters(settings.groupOverrides),
      files: files.filter((f) => !f.voided),
      cycles: cycles.filter((c) => !c.voided).sort((a, b) => a.number - b.number),
      plateRuns: plateRuns.filter((r) => !r.voided),
      errorCodes: errorCodes.filter((r) => !r.voided),
      reactive: reactive.filter((r) => !r.voided),
      downtime: downtime.filter((r) => !r.voided),
      bins: bins.filter((r) => !r.voided),
      deviations: deviations.filter((r) => !r.voided),
      oneTime: oneTime.filter((r) => !r.voided),
      settings,
    };
  });
}

/** The cycle without an end time, if any. */
export function openCycle(ds: Dataset) {
  return ds.cycles.find((c) => !c.endedAt);
}

/** Open downtime for a printer, if any. */
export function openDowntime(ds: Dataset, printerId: string) {
  return ds.downtime.find((d) => d.printerId === printerId && !d.upAt);
}
