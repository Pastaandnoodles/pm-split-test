import { compareUnits, comparePaired, bootstrapMean, wilson, type Interval, type PairedTest, type TwoGroupTest } from './stats';
import { computeGroupCycleYield, crossBinHint, type GroupCycleYield } from './yield';
import type { Cycle, Dataset, FailureType, FileSpec, Group, OneTimeStepKey, PlateRun, Printer } from './types';
import { FAILURE_TYPES, ONE_TIME_STEPS } from './types';

/** Where the parts expected from passed plates ended up, as shares that add up to 1. */
export interface YieldShare {
  good: number;
  seconds: number;
  scrap: number;
  missing: number;
}

/**
 * Pools one or more weighed group-cycles into shares of the expected parts. If the bins hold more than
 * expected (extra parts), the bins become the base, so missing is never negative.
 */
export function yieldShare(rows: GroupCycleYield[]): YieldShare | null {
  const done = rows.filter((y) => y.goodParts !== null && y.secondsParts !== null && y.scrapParts !== null && y.expectedParts > 0);
  if (!done.length) return null;
  const sum = (f: (y: GroupCycleYield) => number) => done.reduce((s, y) => s + f(y), 0);
  const good = sum((y) => Math.max(0, y.goodParts!));
  const seconds = sum((y) => Math.max(0, y.secondsParts!));
  const scrap = sum((y) => Math.max(0, y.scrapParts!));
  const base = Math.max(sum((y) => y.expectedParts), good + seconds + scrap);
  return { good: good / base, seconds: seconds / base, scrap: scrap / base, missing: (base - good - seconds - scrap) / base };
}

/**
 * Wigglitz lost to failed-plate scrap: each cycle's scrap grams ÷ that cycle's file unit weight (rounded),
 * summed over cycles. Cycles whose file has no unit weight are skipped.
 */
export function scrapToParts(failedRuns: PlateRun[], cycles: Cycle[], fileById: Map<string, FileSpec>): number {
  return cycles.reduce((total, cycle) => {
    const unit = fileById.get(cycle.fileId)?.unitWeightG ?? 0;
    if (unit <= 0) return total;
    const grams = failedRuns.filter((r) => r.cycleId === cycle.id).reduce((s, r) => s + (r.scrapMassG ?? 0), 0);
    return total + Math.round(grams / unit);
  }, 0);
}

/** Printer time spent on a plate that produced nothing: the full print if it finished as a fail, the printed share if it stopped. */
export function lostPrintMinutes(r: PlateRun, printTimeMin: number): number {
  if (r.outcome === 'fail_finished') return printTimeMin;
  if (r.outcome === 'fail_stopped') return printTimeMin * ((r.progressPct ?? 0) / 100);
  return 0;
}

export interface AnalysisOptions {
  excludeDeviations: boolean;
  excludeNonPrinterCancels: boolean;
}

export const GROUPS: Group[] = ['control', 'maintenance'];
const PLATES_PER_CYCLE = 38;

export interface GroupOutcome {
  n: number;
  pass: number;
  failFinished: number;
  failStopped: number;
  canceled: number;
  passRate: Interval;
}

export interface PrinterStats {
  printer: Printer;
  n: number;
  pass: number;
  fail: number;
  passRate: number;
  resumed: number;
  fatal: number;
  reactiveCount: number;
  downtimeHours: number;
}

export interface CycleYieldRow {
  cycleId: string;
  cycleNumber: number;
  control: GroupCycleYield;
  maintenance: GroupCycleYield;
  hint: string | null;
}

export interface EconTerm {
  label: string;
  units: string; // e.g. "parts", "min", "g", "h"
  perCycle: number; // in units, positive = in favor of Maintenance
  dollarsPerCycle: number | null;
}

export interface Economics {
  cyclesUsed: number;
  terms: EconTerm[];
  netPerCycle: Interval | null; // dollars; null when dollar inputs are missing
  missingInputs: string[];
}

export interface StepLabor {
  step: OneTimeStepKey;
  minutes: number; // whole group
  printersDone: number;
  avgPerPrinter: number | null;
}

export interface Labor {
  oneTimeMinutes: number;
  perPrintMinutes: number;
  steps: StepLabor[];
  /** Per-print minutes ÷ Maintenance plates, over cycles that have per-print time logged. */
  perPrintAvgPerPlate: number | null;
}

export interface Verdict {
  tone: 'better' | 'worse' | 'none' | 'insufficient';
  headline: string;
  detail: string;
  preliminary: boolean;
}

export interface AnalysisResult {
  progress: Record<Group, number>;
  goal: number;
  final: boolean;
  outcomes: Record<Group, GroupOutcome>;
  perPrinter: PrinterStats[];
  passTest: TwoGroupTest | null;
  cycleYields: CycleYieldRow[];
  yieldTest: PairedTest | null;
  composition: { average: Record<Group, YieldShare | null>; perCycle: { cycleNumber: number; shares: Record<Group, YieldShare | null> }[] };
  trend: { cycleNumber: number; passRate: Record<Group, number | null>; overallYield: Record<Group, number | null> }[];
  failureTypes: Record<FailureType, Record<Group, number>>;
  errors: Record<Group, { resumed: number; fatal: number }>;
  topCodes: { code: string; control: number; maintenance: number }[];
  reactive: Record<Group, { count: number; parts: Record<string, number> }>;
  rows: Record<Group, { top: Interval; bottom: Interval }>;
  scrap: Record<Group, { stoppedCount: number; meanProgressPct: number | null; totalScrapG: number; lostParts: number; lostPrintHours: number }>;
  labor: Labor;
  economics: Economics;
  verdict: Verdict;
}

function isExcluded(run: PlateRun, ds: Dataset, opts: AnalysisOptions): boolean {
  if (opts.excludeNonPrinterCancels && run.outcome === 'fail_stopped' && run.stoppedBy === 'canceled' && run.cancelReason !== 'printer_issue') {
    return true;
  }
  if (opts.excludeDeviations) {
    return ds.deviations.some(
      (d) =>
        !d.voided &&
        d.excludeFromAnalysis &&
        (d.printerId === undefined || d.printerId === run.printerId) &&
        (d.cycleId === undefined || d.cycleId === run.cycleId) &&
        (d.printerId !== undefined || d.cycleId !== undefined),
    );
  }
  return false;
}

function hoursBetween(a: string, b: string): number {
  return Math.max(0, (Date.parse(b) - Date.parse(a)) / 3_600_000);
}

export function analyze(ds: Dataset, opts: AnalysisOptions, now = new Date().toISOString()): AnalysisResult {
  const printerById = new Map(ds.printers.map((p) => [p.id, p]));
  const groupOf = (printerId: string): Group | undefined => printerById.get(printerId)?.group;
  const liveRuns = ds.plateRuns.filter((r) => !r.voided && printerById.has(r.printerId));
  const runs = liveRuns.filter((r) => !isExcluded(r, ds, opts));
  const errors = ds.errorCodes.filter((e) => !e.voided);
  const reactive = ds.reactive.filter((r) => !r.voided);
  const downtime = ds.downtime.filter((d) => !d.voided);
  const cycles = ds.cycles.filter((c) => !c.voided).sort((a, b) => a.number - b.number);
  const fileById = new Map(ds.files.filter((f) => !f.voided).map((f) => [f.id, f]));
  const settings = ds.settings;

  // Progress counts every logged plate; exclusions only affect the statistics.
  const progress = { control: 0, maintenance: 0 } as Record<Group, number>;
  for (const r of liveRuns) progress[groupOf(r.printerId)!]++;
  const goal = settings.goalPerGroup;
  const final = progress.control >= goal && progress.maintenance >= goal;

  const outcomes = {} as Record<Group, GroupOutcome>;
  for (const g of GROUPS) {
    const gr = runs.filter((r) => groupOf(r.printerId) === g);
    const pass = gr.filter((r) => r.outcome === 'pass').length;
    outcomes[g] = {
      n: gr.length,
      pass,
      failFinished: gr.filter((r) => r.outcome === 'fail_finished').length,
      failStopped: gr.filter((r) => r.outcome === 'fail_stopped' && r.stoppedBy !== 'canceled').length,
      canceled: gr.filter((r) => r.outcome === 'fail_stopped' && r.stoppedBy === 'canceled').length,
      passRate: wilson(pass, gr.length),
    };
  }

  const perPrinter: PrinterStats[] = ds.printers.map((printer) => {
    const pr = runs.filter((r) => r.printerId === printer.id);
    const pass = pr.filter((r) => r.outcome === 'pass').length;
    const pe = errors.filter((e) => e.printerId === printer.id);
    const rm = reactive.filter((r) => r.printerId === printer.id);
    const dt = downtime
      .filter((d) => d.printerId === printer.id)
      .reduce((s, d) => s + hoursBetween(d.downAt, d.upAt ?? now), 0);
    return {
      printer,
      n: pr.length,
      pass,
      fail: pr.length - pass,
      passRate: pr.length ? pass / pr.length : NaN,
      resumed: pe.filter((e) => e.disposition === 'resumed').length,
      fatal: pe.filter((e) => e.disposition === 'fatal').length,
      reactiveCount: rm.length,
      downtimeHours: dt,
    };
  });

  // The printer is the statistical unit: compare per-printer pass rates.
  const rates = (g: Group) => perPrinter.filter((p) => p.printer.group === g && p.n > 0).map((p) => p.passRate);
  const cRates = rates('control');
  const mRates = rates('maintenance');
  const passTest = cRates.length >= 2 && mRates.length >= 2 ? compareUnits(cRates, mRates) : null;

  const cycleYields: CycleYieldRow[] = cycles.map((cycle) => {
    const file = fileById.get(cycle.fileId);
    const [control, maintenance] = GROUPS.map((g) =>
      computeGroupCycleYield(cycle, file, g, liveRuns, ds.printers, ds.bins, settings.missingTolerancePct),
    );
    return {
      cycleId: cycle.id,
      cycleNumber: cycle.number,
      control,
      maintenance,
      hint: crossBinHint(control, maintenance, file?.partsPerPlate ?? 0),
    };
  });
  const yieldDiffs = cycleYields
    .filter((c) => c.control.overallYield !== null && c.maintenance.overallYield !== null)
    .map((c) => c.maintenance.overallYield! - c.control.overallYield!);
  const yieldTest = yieldDiffs.length >= 2 ? comparePaired(yieldDiffs) : null;

  const trend = cycles.map((cycle) => {
    const row = cycleYields.find((y) => y.cycleId === cycle.id)!;
    const passRate = {} as Record<Group, number | null>;
    for (const g of GROUPS) {
      const gr = runs.filter((r) => r.cycleId === cycle.id && groupOf(r.printerId) === g);
      passRate[g] = gr.length ? gr.filter((r) => r.outcome === 'pass').length / gr.length : null;
    }
    return {
      cycleNumber: cycle.number,
      passRate,
      overallYield: { control: row.control.overallYield, maintenance: row.maintenance.overallYield },
    };
  });

  const failureTypes = {} as Record<FailureType, Record<Group, number>>;
  for (const t of FAILURE_TYPES) failureTypes[t] = { control: 0, maintenance: 0 };
  for (const r of runs) if (r.outcome !== 'pass' && r.failureType) failureTypes[r.failureType][groupOf(r.printerId)!]++;

  const errorsByGroup = { control: { resumed: 0, fatal: 0 }, maintenance: { resumed: 0, fatal: 0 } };
  const codeCounts = new Map<string, { control: number; maintenance: number }>();
  for (const e of errors) {
    const g = groupOf(e.printerId);
    if (!g) continue;
    errorsByGroup[g][e.disposition]++;
    const c = codeCounts.get(e.code) ?? { control: 0, maintenance: 0 };
    c[g]++;
    codeCounts.set(e.code, c);
  }
  const topCodes = [...codeCounts.entries()]
    .map(([code, c]) => ({ code, ...c }))
    .sort((a, b) => b.control + b.maintenance - (a.control + a.maintenance))
    .slice(0, 10);

  const reactiveByGroup = {} as AnalysisResult['reactive'];
  for (const g of GROUPS) {
    const gr = reactive.filter((r) => groupOf(r.printerId) === g);
    const parts: Record<string, number> = {};
    for (const r of gr) if (r.part) parts[r.part] = (parts[r.part] ?? 0) + 1;
    reactiveByGroup[g] = { count: gr.length, parts };
  }

  const rows = {} as AnalysisResult['rows'];
  for (const g of GROUPS) {
    const rowRate = (row: 'a' | 'b') => {
      const gr = runs.filter((r) => printerById.get(r.printerId)?.group === g && printerById.get(r.printerId)?.row === row);
      return wilson(gr.filter((r) => r.outcome === 'pass').length, gr.length);
    };
    rows[g] = { top: rowRate('a'), bottom: rowRate('b') };
  }

  const scrap = {} as AnalysisResult['scrap'];
  for (const g of GROUPS) {
    const gr = runs.filter((r) => groupOf(r.printerId) === g && r.outcome !== 'pass');
    const stopped = gr.filter((r) => r.outcome === 'fail_stopped' && typeof r.progressPct === 'number');
    scrap[g] = {
      stoppedCount: stopped.length,
      meanProgressPct: stopped.length ? stopped.reduce((s, r) => s + r.progressPct!, 0) / stopped.length : null,
      totalScrapG: gr.reduce((s, r) => s + (r.scrapMassG ?? 0), 0),
      lostParts: scrapToParts(gr, cycles, fileById),
      lostPrintHours: gr.reduce((s, r) => s + lostPrintMinutes(r, fileById.get(cycles.find((c) => c.id === r.cycleId)?.fileId ?? '')?.printTimeMin ?? 0), 0) / 60,
    };
  }

  const labor = computeLabor(ds, liveRuns, groupOf);
  const economics = computeEconomics(ds, liveRuns, cycleYields, groupOf, labor.oneTimeMinutes, now);

  return {
    progress,
    goal,
    final,
    outcomes,
    perPrinter,
    passTest,
    cycleYields,
    yieldTest,
    composition: {
      average: { control: yieldShare(cycleYields.map((c) => c.control)), maintenance: yieldShare(cycleYields.map((c) => c.maintenance)) },
      perCycle: cycleYields.map((c) => ({ cycleNumber: c.cycleNumber, shares: { control: yieldShare([c.control]), maintenance: yieldShare([c.maintenance]) } })),
    },
    trend,
    failureTypes,
    errors: errorsByGroup,
    topCodes,
    reactive: reactiveByGroup,
    rows,
    scrap,
    labor,
    economics,
    verdict: buildVerdict(final, yieldTest, passTest),
  };
}

/** PM time is logged for the whole Maintenance group; averages per printer and per plate are derived here. */
export function computeLabor(ds: Dataset, runs: PlateRun[], groupOf: (id: string) => Group | undefined): Labor {
  const times = ds.pmTime.filter((t) => !t.voided);
  const steps = ONE_TIME_STEPS.map((step) => {
    const minutes = times.filter((t) => t.scope === 'one_time' && t.step === step).reduce((s, t) => s + t.minutes, 0);
    const printersDone = new Set(ds.oneTime.filter((s) => !s.voided && s.step === step).map((s) => s.printerId)).size;
    return { step, minutes, printersDone, avgPerPrinter: printersDone > 0 && minutes > 0 ? minutes / printersDone : null };
  });
  const perPrint = times.filter((t) => t.scope === 'per_print');
  const perPrintMinutes = perPrint.reduce((s, t) => s + t.minutes, 0);
  const timedCycles = new Set(perPrint.map((t) => t.cycleId));
  const timedPlates = runs.filter((r) => timedCycles.has(r.cycleId) && groupOf(r.printerId) === 'maintenance').length;
  return {
    oneTimeMinutes: steps.reduce((s, x) => s + x.minutes, 0),
    perPrintMinutes,
    steps,
    perPrintAvgPerPlate: timedPlates > 0 ? perPrintMinutes / timedPlates : null,
  };
}

function computeEconomics(
  ds: Dataset,
  runs: PlateRun[],
  cycleYields: CycleYieldRow[],
  groupOf: (id: string) => Group | undefined,
  oneTimeMinutes: number,
  now: string,
): Economics {
  const s = ds.settings;
  const missingInputs: string[] = [];
  if (s.valuePerGoodPart === undefined) missingInputs.push('Value per good wigglitz');
  if (s.laborRatePerHr === undefined) missingInputs.push('Labor rate');
  if (s.filamentCostPerKg === undefined) missingInputs.push('Filament cost');
  if (s.machineHourValue === undefined) missingInputs.push('Machine-hour value');
  if (ds.cycles.some((c) => !c.voided && ds.files.find((f) => f.id === c.fileId)?.printTimeMin === undefined)) missingInputs.push('Print time for some files');
  const printTimeOf = (cycleId: string) => {
    const cycle = ds.cycles.find((c) => c.id === cycleId);
    return ds.files.find((f) => f.id === cycle?.fileId)?.printTimeMin ?? 0;
  };

  const usable = cycleYields.filter((c) => c.control.goodParts !== null && c.maintenance.goodParts !== null);
  const plannedCycles = Math.max(Math.ceil(s.goalPerGroup / PLATES_PER_CYCLE), usable.length, 1);

  const downtimeHours = (g: Group) =>
    ds.downtime
      .filter((d) => !d.voided && groupOf(d.printerId) === g)
      .reduce((sum, d) => sum + hoursBetween(d.downAt, d.upAt ?? now), 0);
  const cyclesSoFar = Math.max(ds.cycles.filter((c) => !c.voided).length, 1);
  const downtimeSavedPerCycle = (downtimeHours('control') - downtimeHours('maintenance')) / cyclesSoFar;

  type CycleTerms = { good: number; scrapG: number; lostMin: number; pmMin: number; calibMin: number };
  const perCycle: CycleTerms[] = usable.map((c) => {
    const scale = (y: GroupCycleYield) => (y.platesStarted > 0 ? PLATES_PER_CYCLE / y.platesStarted : 0);
    const sC = scale(c.control);
    const sM = scale(c.maintenance);
    const inCycle = (g: Group) => runs.filter((r) => r.cycleId === c.cycleId && groupOf(r.printerId) === g);
    const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
    const mRuns = inCycle('maintenance');
    const printMin = printTimeOf(c.cycleId);
    return {
      good: c.maintenance.goodParts! * sM - c.control.goodParts! * sC,
      scrapG: sum(inCycle('control'), (r) => r.scrapMassG ?? 0) * sC - sum(mRuns, (r) => r.scrapMassG ?? 0) * sM,
      lostMin: sum(inCycle('control'), (r) => lostPrintMinutes(r, printMin)) * sC - sum(mRuns, (r) => lostPrintMinutes(r, printMin)) * sM,
      pmMin:
        sum(ds.pmTime.filter((t) => !t.voided && t.scope === 'per_print' && t.cycleId === c.cycleId), (t) => t.minutes) * sM +
        oneTimeMinutes / plannedCycles,
      calibMin: mRuns.filter((r) => r.checks.calibrationRun).length * sM * s.calibrationMachineMinutes,
    };
  });

  const avg = (f: (t: CycleTerms) => number) => (perCycle.length ? perCycle.reduce((a, t) => a + f(t), 0) / perCycle.length : 0);
  const labor = s.laborRatePerHr;
  const machine = s.machineHourValue;
  const dollars = (v: number | undefined, f: (rate: number) => number) => (v === undefined ? null : f(v));

  const terms: EconTerm[] = [
    { label: 'Extra good parts', units: 'parts', perCycle: avg((t) => t.good), dollarsPerCycle: dollars(s.valuePerGoodPart, (v) => avg((t) => t.good) * v) },
    { label: 'Scrap filament saved', units: 'g', perCycle: avg((t) => t.scrapG), dollarsPerCycle: dollars(s.filamentCostPerKg, (v) => (avg((t) => t.scrapG) / 1000) * v) },
    { label: 'Printer time wasted on failed plates saved', units: 'min', perCycle: avg((t) => t.lostMin), dollarsPerCycle: dollars(machine, (v) => (avg((t) => t.lostMin) / 60) * v) },
    { label: 'Downtime saved', units: 'h', perCycle: downtimeSavedPerCycle, dollarsPerCycle: dollars(machine, (v) => downtimeSavedPerCycle * v) },
    { label: 'PM labor (one-time spread over test + per print)', units: 'min', perCycle: -avg((t) => t.pmMin), dollarsPerCycle: dollars(labor, (v) => (-avg((t) => t.pmMin) / 60) * v) },
    { label: 'Calibration machine time', units: 'min', perCycle: -avg((t) => t.calibMin), dollarsPerCycle: dollars(machine, (v) => (-avg((t) => t.calibMin) / 60) * v) },
  ];

  let netPerCycle: Interval | null = null;
  if (perCycle.length > 0 && s.valuePerGoodPart !== undefined && labor !== undefined) {
    const net = perCycle.map(
      (t) =>
        t.good * s.valuePerGoodPart! +
        (t.scrapG / 1000) * (s.filamentCostPerKg ?? 0) +
        (t.lostMin / 60) * (machine ?? 0) +
        downtimeSavedPerCycle * (machine ?? 0) -
        (t.pmMin / 60) * labor -
        (t.calibMin / 60) * (machine ?? 0),
    );
    netPerCycle = bootstrapMean(net);
  }

  return { cyclesUsed: perCycle.length, terms, netPerCycle, missingInputs };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}`;
}

export function buildVerdict(final: boolean, yieldTest: PairedTest | null, passTest: TwoGroupTest | null): Verdict {
  const preliminary = !final;
  const suffix = preliminary ? ' yet' : '';
  if (yieldTest && yieldTest.n >= 2 && Number.isFinite(yieldTest.pValue)) {
    const { meanDiff, ci, pValue } = yieldTest;
    const range = Number.isFinite(ci.low) ? ` (likely range ${pct(ci.low)} to ${pct(ci.high)})` : '';
    const detail = `Maintenance produced ${meanDiff >= 0 ? pct(meanDiff) + ' more' : pct(-meanDiff) + ' fewer'} good parts per 100 printed${range}, across ${yieldTest.n} cycles.`;
    if (pValue < 0.05) {
      return meanDiff > 0
        ? { tone: 'better', headline: 'Maintenance is clearly better', detail, preliminary }
        : { tone: 'worse', headline: 'Control is clearly better', detail, preliminary };
    }
    return { tone: 'none', headline: `No clear difference${suffix}`, detail, preliminary };
  }
  if (passTest && Number.isFinite(passTest.pValue)) {
    const { diff, ci, pValue } = passTest;
    const range = Number.isFinite(ci.low) ? ` (likely range ${pct(ci.low)} to ${pct(ci.high)} points)` : '';
    const detail = `Plate pass rate is ${diff >= 0 ? pct(diff) + ' points higher' : pct(-diff) + ' points lower'} on Maintenance printers${range}. Yield needs at least 2 weighed cycles.`;
    if (pValue < 0.05) {
      return diff > 0
        ? { tone: 'better', headline: 'Maintenance is clearly better', detail, preliminary }
        : { tone: 'worse', headline: 'Control is clearly better', detail, preliminary };
    }
    return { tone: 'none', headline: `No clear difference${suffix}`, detail, preliminary };
  }
  return {
    tone: 'insufficient',
    headline: 'Not enough data yet',
    detail: 'Log plates on at least 2 printers per group, or weigh bins for at least 2 cycles.',
    preliminary,
  };
}
