import { describe, expect, it } from 'vitest';
import { buildPrinters, defaultGroup, parsePrinterId, printerId, shelfOf } from './printers';
import { computeGroupCycleYield, crossBinHint, partsFromWeight } from './yield';
import { comparePaired, compareUnits, wilson } from './stats';
import { analyze, buildVerdict, lostPrintMinutes, repairMinutes, yieldShare } from './analysis';
import { DEFAULT_SETTINGS, type BinWeight, type Cycle, type Dataset, type FileSpec, type PlateRun, type PmTime } from './types';

const T = '2026-10-22T08:00:00.000Z';
const base = (id: string) => ({ id, createdAt: T, updatedAt: T });
const checks = { purgeCleared: true, nozzleWiped: false, plateCleaned: true, calibrationRun: true };

function run(id: string, printer: string, cycleId: string, outcome: PlateRun['outcome'], extra: Partial<PlateRun> = {}): PlateRun {
  return { ...base(id), printerId: printer, cycleId, outcome, checks, correctPlatePool: true, ...extra };
}

describe('printers', () => {
  it('builds 76 printers, 38 per group, 19 top and 19 bottom each', () => {
    const ps = buildPrinters();
    expect(ps).toHaveLength(76);
    for (const g of ['control', 'maintenance'] as const) {
      const gp = ps.filter((p) => p.group === g);
      expect(gp).toHaveLength(38);
      expect(gp.filter((p) => p.row === 'a')).toHaveLength(19);
    }
  });

  it('puts the left column of each shelf in Control and the right in Maintenance', () => {
    expect(defaultGroup(1)).toBe('control');
    expect(defaultGroup(2)).toBe('maintenance');
    expect(shelfOf(1)).toBe(1);
    expect(shelfOf(2)).toBe(1);
    expect(shelfOf(38)).toBe(19);
  });

  it('formats and parses ids', () => {
    expect(printerId(5, 'a')).toBe('H-05a');
    expect(parsePrinterId('H-38b')).toEqual({ column: 38, row: 'b' });
    expect(parsePrinterId('H-39a')).toBeNull();
  });

  it('applies overrides', () => {
    const ps = buildPrinters({ 'H-01a': 'maintenance' });
    expect(ps.find((p) => p.id === 'H-01a')!.group).toBe('maintenance');
  });
});

describe('yield', () => {
  const printers = buildPrinters();
  const file: FileSpec = { ...base('f1'), name: 'test', partsPerPlate: 100, unitWeightG: 2.5 };
  const cycle: Cycle = { ...base('c1'), number: 1, fileId: 'f1', startedAt: T, binTareG: 500 };

  it('converts weight to parts', () => {
    expect(partsFromWeight(500 + 2.5 * 40, 500, 2.5)).toBe(40);
  });

  it('computes expected, good, rejected, missing and yields', () => {
    // Control printers: H-01a, H-01b, H-03a ... 10 pass, 2 fail
    const ctrl = printers.filter((p) => p.group === 'control').slice(0, 12);
    const runs = ctrl.map((p, i) => run(`r${i}`, p.id, 'c1', i < 10 ? 'pass' : 'fail_finished'));
    const bins: BinWeight[] = [
      { ...base('b1'), cycleId: 'c1', group: 'control', kind: 'good', grossG: 500 + 2.5 * 900 },
      { ...base('b2'), cycleId: 'c1', group: 'control', kind: 'seconds', grossG: 500 + 2.5 * 40 },
      { ...base('b3'), cycleId: 'c1', group: 'control', kind: 'scrap', grossG: 500 + 2.5 * 30 },
    ];
    const y = computeGroupCycleYield(cycle, file, 'control', runs, printers, bins, 2);
    expect(y.expectedParts).toBe(1000);
    expect(y.goodParts).toBe(900);
    expect(y.secondsParts).toBe(40);
    expect(y.scrapParts).toBe(30);
    expect(y.rejectedParts).toBe(70);
    expect(y.missingParts).toBe(30);
    expect(y.qcYield).toBeCloseTo(900 / 970);
    expect(y.overallYield).toBeCloseTo(900 / 1200);
    expect(y.flags.some((f) => f.includes('missing'))).toBe(true);
  });

  it('does not flag when within tolerance', () => {
    const ctrl = printers.filter((p) => p.group === 'control').slice(0, 10);
    const runs = ctrl.map((p, i) => run(`r${i}`, p.id, 'c1', 'pass'));
    const bins: BinWeight[] = [
      { ...base('b1'), cycleId: 'c1', group: 'control', kind: 'good', grossG: 500 + 2.5 * 950 },
      { ...base('b2'), cycleId: 'c1', group: 'control', kind: 'seconds', grossG: 500 + 2.5 * 25 },
      { ...base('b3'), cycleId: 'c1', group: 'control', kind: 'scrap', grossG: 500 + 2.5 * 15 },
    ];
    const y = computeGroupCycleYield(cycle, file, 'control', runs, printers, bins, 2);
    expect(y.missingParts).toBe(10);
    expect(y.flags).toEqual([]);
  });

  it('hints at a plate in the wrong bin', () => {
    const mk = (missing: number) => ({ missingParts: missing }) as never;
    expect(crossBinHint(mk(100), mk(-95), 100)).toMatch(/wrong group/);
    expect(crossBinHint(mk(100), mk(10), 100)).toBeNull();
  });
});

describe('stats', () => {
  it('wilson interval brackets the estimate', () => {
    const w = wilson(45, 50);
    expect(w.estimate).toBeCloseTo(0.9);
    expect(w.low).toBeLessThan(0.9);
    expect(w.high).toBeGreaterThan(0.9);
    expect(w.high).toBeLessThanOrEqual(1);
  });

  it('detects a clear difference between units and not a null one', () => {
    const a = Array.from({ length: 38 }, (_, i) => 0.8 + (i % 5) * 0.01);
    const b = Array.from({ length: 38 }, (_, i) => 0.95 + (i % 5) * 0.01);
    expect(compareUnits(a, b).pValue).toBeLessThan(0.01);
    expect(compareUnits(a, [...a]).pValue).toBeGreaterThan(0.5);
  });

  it('paired test on consistent positive diffs', () => {
    const t = comparePaired([0.03, 0.04, 0.02, 0.05, 0.03, 0.04, 0.03, 0.04]);
    expect(t.meanDiff).toBeCloseTo(0.035);
    expect(t.pValue).toBeLessThan(0.05);
    expect(t.ci.low).toBeGreaterThan(0);
  });
});

describe('analysis', () => {
  function dataset(): Dataset {
    const printers = buildPrinters();
    const files: FileSpec[] = [{ ...base('f1'), name: 'w', partsPerPlate: 100, unitWeightG: 2 }];
    const cycles: Cycle[] = [1, 2, 3].map((n) => ({ ...base(`c${n}`), number: n, fileId: 'f1', startedAt: T, binTareG: 0 }));
    const plateRuns: PlateRun[] = [];
    const bins: BinWeight[] = [];
    const pmTime: PmTime[] = [];
    for (const c of cycles) {
      for (const p of printers) {
        // Maintenance: all pass. Control: every 4th printer fails.
        const fail = p.group === 'control' && p.column % 4 === 1 && p.row === 'a';
        plateRuns.push(run(`${c.id}-${p.id}`, p.id, c.id, fail ? 'fail_stopped' : 'pass', fail ? { stoppedBy: 'printer', progressPct: 40, scrapMassG: 80 } : {}));
      }
      const passC = plateRuns.filter((r) => r.cycleId === c.id && r.outcome === 'pass' && printers.find((p) => p.id === r.printerId)!.group === 'control').length;
      bins.push({ ...base(`${c.id}-cg`), cycleId: c.id, group: 'control', kind: 'good', grossG: passC * 95 * 2 });
      bins.push({ ...base(`${c.id}-cs`), cycleId: c.id, group: 'control', kind: 'seconds', grossG: passC * 3 * 2 });
      bins.push({ ...base(`${c.id}-cx`), cycleId: c.id, group: 'control', kind: 'scrap', grossG: passC * 2 * 2 });
      bins.push({ ...base(`${c.id}-mg`), cycleId: c.id, group: 'maintenance', kind: 'good', grossG: 38 * 97 * 2 });
      bins.push({ ...base(`${c.id}-ms`), cycleId: c.id, group: 'maintenance', kind: 'seconds', grossG: 38 * 2 * 2 });
      bins.push({ ...base(`${c.id}-mx`), cycleId: c.id, group: 'maintenance', kind: 'scrap', grossG: 38 * 1 * 2 });
      pmTime.push({ ...base(`${c.id}-pt`), scope: 'per_print', cycleId: c.id, minutes: 114 });
    }
    return {
      printers,
      files,
      cycles,
      plateRuns,
      errorCodes: [],
      reactive: [],
      downtime: [],
      bins,
      deviations: [],
      oneTime: printers.filter((p) => p.group === 'maintenance').map((p) => ({ ...base(`ot-${p.id}`), printerId: p.id, step: 'fans' as const, doneAt: T })),
      pmTime: [...pmTime, { ...base('ot-fans'), scope: 'one_time', step: 'fans', minutes: 190 }],
      settings: { ...DEFAULT_SETTINGS, valuePerGoodPart: 0.5, laborRatePerHr: 20 },
    };
  }

  it('summarizes outcomes, yields and economics', () => {
    const r = analyze(dataset(), { excludeDeviations: true, excludeNonPrinterCancels: true }, T);
    expect(r.progress.control).toBe(114);
    expect(r.final).toBe(false);
    expect(r.outcomes.maintenance.pass).toBe(114);
    expect(r.outcomes.control.failStopped).toBe(30);
    expect(r.cycleYields).toHaveLength(3);
    expect(r.cycleYields[0].maintenance.missingParts).toBe(0);
    expect(r.yieldTest!.meanDiff).toBeGreaterThan(0);
    expect(r.economics.netPerCycle).not.toBeNull();
    expect(r.scrap.control.meanProgressPct).toBe(40);
    expect(r.verdict.preliminary).toBe(true);
    expect(r.cycleYields[0].maintenance.secondsParts).toBe(76);
    expect(r.labor.steps[0]).toMatchObject({ step: 'fans', minutes: 190, printersDone: 38, avgPerPrinter: 5 });
    expect(r.labor.perPrintMinutes).toBe(342);
    expect(r.labor.perPrintAvgPerPlate).toBeCloseTo(3); // 342 min / 114 Maintenance plates
  });

  it('excludes non-printer cancels when asked', () => {
    const ds = dataset();
    ds.plateRuns[0] = { ...ds.plateRuns[0], outcome: 'fail_stopped', stoppedBy: 'canceled', cancelReason: 'operator' };
    const withEx = analyze(ds, { excludeDeviations: true, excludeNonPrinterCancels: true }, T);
    const without = analyze(ds, { excludeDeviations: true, excludeNonPrinterCancels: false }, T);
    expect(without.outcomes.control.n - withEx.outcomes.control.n).toBe(1);
    expect(withEx.progress.control).toBe(without.progress.control);
  });

  it('values wasted printer time and repairs without per-event timing', () => {
    const r = (outcome: PlateRun['outcome'], progressPct?: number) => run('x', 'H-01a', 'c1', outcome, { progressPct });
    expect(lostPrintMinutes(r('pass'), 300)).toBe(0);
    expect(lostPrintMinutes(r('fail_finished'), 300)).toBe(300);
    expect(lostPrintMinutes(r('fail_stopped', 40), 300)).toBe(120);
    const settings = { ...DEFAULT_SETTINGS, repairMinutes: { clear_clog: 15 } };
    const repair = { ...base('m'), printerId: 'H-01a', action: 'clear_clog' as const };
    expect(repairMinutes(repair, settings)).toBe(15);
    expect(repairMinutes({ ...repair, action: 'replace_fan' }, settings)).toBe(0);
    expect(repairMinutes({ ...repair, minutes: 40 }, settings)).toBe(40);
  });

  it('splits expected parts into good, seconds, scrap and missing shares', () => {
    const y = (good: number, seconds: number, scrap: number, expected: number) =>
      ({ goodParts: good, secondsParts: seconds, scrapParts: scrap, expectedParts: expected }) as never;
    const s = yieldShare([y(900, 40, 30, 1000)])!;
    expect(s.good).toBeCloseTo(0.9);
    expect(s.missing).toBeCloseTo(0.03);
    expect(s.good + s.seconds + s.scrap + s.missing).toBeCloseTo(1);
    // Pooled across cycles, and extra parts never make "missing" negative.
    const p = yieldShare([y(900, 40, 30, 1000), y(1010, 0, 0, 1000)])!;
    expect(p.missing).toBeGreaterThanOrEqual(0);
    expect(p.good).toBeCloseTo(1910 / 2010);
    expect(yieldShare([y(900, 40, 30, 0)])).toBeNull();
  });

  it('labels verdicts as preliminary until final', () => {
    expect(buildVerdict(false, null, null).tone).toBe('insufficient');
    const v = buildVerdict(true, { meanDiff: 0.05, ci: { estimate: 0.05, low: 0.02, high: 0.08 }, pValue: 0.01, n: 14 }, null);
    expect(v.tone).toBe('better');
    expect(v.preliminary).toBe(false);
  });
});
