import { db, RECORD_TABLES } from './db';
import { buildPrinters } from '../domain/printers';
import { rng } from '../domain/stats';
import { DEFAULT_SETTINGS, FAILURE_TYPES, ONE_TIME_STEPS, type BaseRecord, type PlateRun } from '../domain/types';

/** Erases every table on this device. */
export async function eraseAll(): Promise<void> {
  const all = [...RECORD_TABLES.map((t) => db[t]), db.settings, db.audit, db.photos];
  await db.transaction('rw', all, async () => {
    for (const t of all) await t.clear();
  });
}

/** Fills the database with 4 made-up cycles so the app can be tried out. Replaces existing data. */
export async function loadDemo(): Promise<void> {
  await eraseAll();
  const rand = rng(42);
  const printers = buildPrinters();
  const t0 = Date.parse('2026-10-01T07:00:00Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const rec = (ms: number): BaseRecord => ({ id: crypto.randomUUID(), createdAt: iso(ms), updatedAt: iso(ms) });

  await db.settings.put({ ...DEFAULT_SETTINGS, testLocked: true, laborRatePerHr: 22, valuePerGoodPart: 0.4, filamentCostPerKg: 20, machineHourValue: 1.5, calibrationMachineMinutes: 4, partCosts: { Nozzle: 18, Fan: 9 } });
  const file = { ...rec(t0), name: 'DEMO wigglitz v1', partsPerPlate: 100, unitWeightG: 3.2, sampleCount: 20, sampleWeightG: 64 };
  await db.files.add(file);

  for (const p of printers.filter((x) => x.group === 'maintenance')) {
    for (const step of ONE_TIME_STEPS) await db.oneTime.add({ ...rec(t0), printerId: p.id, step, doneAt: iso(t0) });
  }
  for (const [step, minutes] of [['fans', 190], ['debris', 150], ['leadScrews', 305], ['nozzle', 115]] as const) {
    await db.pmTime.add({ ...rec(t0), scope: 'one_time', step, minutes });
  }

  for (let n = 1; n <= 4; n++) {
    const start = t0 + n * 86_400_000;
    const cycle = { ...rec(start), number: n, fileId: file.id, startedAt: iso(start), endedAt: iso(start + 10 * 3_600_000), binTareG: 850 };
    await db.cycles.add(cycle);
    const good = { control: 0, maintenance: 0 };
    const rej = { control: 0, maintenance: 0 };
    for (const p of printers) {
      const isM = p.group === 'maintenance';
      const r = rand();
      const failP = isM ? 0.06 : 0.13;
      const run: PlateRun = {
        ...rec(start + 9 * 3_600_000),
        printerId: p.id,
        cycleId: cycle.id,
        outcome: 'pass',
        checks: { purgeCleared: isM && rand() < 0.4, nozzleWiped: isM && rand() < 0.2, plateCleaned: isM, calibrationRun: isM },
        correctPlatePool: true,
      };
      if (r < failP) {
        const stopped = rand() < 0.6;
        Object.assign(run, {
          outcome: stopped ? 'fail_stopped' : 'fail_finished',
          stoppedBy: stopped ? (rand() < 0.15 ? 'canceled' : 'printer') : undefined,
          failureType: FAILURE_TYPES[Math.floor(rand() * 9)],
          progressPct: stopped ? Math.round(5 + rand() * 85) : undefined,
          scrapMassG: Math.round(40 + rand() * 260),
        });
        if (run.stoppedBy === 'canceled') run.cancelReason = 'printer_issue';
      } else {
        const bad = Math.round(rand() * (isM ? 5 : 9));
        good[p.group] += 100 - bad;
        rej[p.group] += bad;
      }
      await db.plateRuns.add(run);
      if (rand() < (isM ? 0.08 : 0.15)) {
        await db.errorCodes.add({ ...rec(start), printerId: p.id, cycleId: cycle.id, code: rand() < 0.5 ? '0300-0100-0001-0007' : '0700-2000-0002-0001', disposition: run.outcome === 'pass' ? 'resumed' : 'fatal' });
      }
      if (rand() < (isM ? 0.03 : 0.08)) {
        await db.reactive.add({ ...rec(start), printerId: p.id, cycleId: cycle.id, action: 'clear_clog', part: rand() < 0.3 ? 'Nozzle' : undefined, minutes: Math.round(10 + rand() * 20) });
      }
    }
    const weigh = (parts: number, noise: number) => Math.round((850 + parts * 3.2 + (rand() - 0.5) * noise) * 10) / 10;
    for (const g of ['control', 'maintenance'] as const) {
      const seconds = Math.round(rej[g] * 0.6);
      await db.bins.add({ ...rec(start), cycleId: cycle.id, group: g, kind: 'good', grossG: weigh(good[g], 20) });
      await db.bins.add({ ...rec(start), cycleId: cycle.id, group: g, kind: 'seconds', grossG: weigh(seconds, 6) });
      await db.bins.add({ ...rec(start), cycleId: cycle.id, group: g, kind: 'scrap', grossG: weigh(rej[g] - seconds, 6) });
    }
    await db.pmTime.add({ ...rec(start), scope: 'per_print', cycleId: cycle.id, minutes: Math.round(100 + rand() * 30) });
  }
}
